import * as path from "path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeRepoMap } from "./retrieval/repomap";
import { HybridSearchIndex } from "./retrieval/search_index";
import type { SearchProfile } from "./retrieval/search_config";
import { SearchControlModal } from "./retrieval/search_modal";
import { checkSyntax } from "./editing/syntax-verify";
import {
	globalEpistemicGuard,
	resolveUserPath,
} from "./safety/epistemic_guard";
import { loadKernelConfig } from "./config";
import { kernelDebug } from "./safety/kernel_debug";
import { registerRepoMapTool } from "./tools/repo_map_tool";
import { registerAstSearchTool } from "./tools/ast_search_tool";
import { registerCodeSearchTool } from "./tools/code_search_tool";
import { registerReadTool } from "./tools/read_tool";
import { registerEditTool } from "./tools/edit_tool";
import { registerLspTool } from "./tools/lsp_tool";

/**
 * Resolve the current session id from a handler context, or fall back to a
 * shared default for single-session CLI use and in-memory sessions that
 * have no UUID assigned.
 */
let fallbackSessionCounter = 0;
const fallbackSessionIds = new WeakMap<object, string>();

function getSessionId(ctx: any): string {
	const provided = ctx?.sessionManager?.getSessionId?.();
	if (typeof provided === "string" && provided.length > 0) return provided;

	if (ctx && (typeof ctx === "object" || typeof ctx === "function")) {
		let fallback = fallbackSessionIds.get(ctx);
		if (!fallback) {
			fallback = `__default__${process.pid}_${++fallbackSessionCounter}__`;
			fallbackSessionIds.set(ctx, fallback);
		}
		return fallback;
	}

	return `__default__${process.pid}`;
}
import { clampCommandOutput } from "./safety/output_clamper";
import { sanitizeSessionFiles } from "./context/session_repair";
import { renderFooter } from "./ui/footer";
import { DedupStore } from "./dedup/content_store";
import { registerRecallTool } from "./dedup/recall_tool";
import {
	LspManager,
	LspControlModal,
	LspDownloadModal,
	formatDiagnostics,
	installLanguageServer,
	LSP_SERVERS,
	findExecutable,
} from "./lsp";

export default async function unifiedHybridExtension(pi: ExtensionAPI) {
	// 0. Auto-Sanitize Session Files (Repairs pre-existing incomplete usage metadata)
	try {
		sanitizeSessionFiles();
	} catch (e) {
		kernelDebug(e);
	}

	// 0b. Dedup store: shared across all sessions in this process. Per-session
	// state is keyed by sessionId. A single instance lets the dedup store
	// benefit from cross-session LRU and lets the recall tool look up refs
	// from any active session.
	const dedupStore = new DedupStore();
	const getDedupStore = () => dedupStore;

	// 3. Slash Commands: /repomap, /engine, /lsp
	let activeTui: any = null;
	const configByWorkspace = new Map<
		string,
		ReturnType<typeof loadKernelConfig>
	>();
	const getConfig = (cwd: string) => {
		const workspace = path.resolve(cwd);
		let config = configByWorkspace.get(workspace);
		if (!config) {
			config = loadKernelConfig(workspace);
			configByWorkspace.set(workspace, config);
		}
		return config;
	};
	const searchIndexes = new Map<string, HybridSearchIndex>();
	const getSearchIndex = (cwd: string) => {
		const workspace = path.resolve(cwd);
		let index = searchIndexes.get(workspace);
		if (!index) {
			index = new HybridSearchIndex(workspace);
			searchIndexes.set(workspace, index);
		}
		return index;
	};

	// Helper: Background index synchronization with TUI progress bar widget
	const triggerBackgroundIndexing = (
		index: HybridSearchIndex,
		ctx: any,
		isFullSync = false,
	) => {
		const eff = index.getEffectiveProfile();
		if (eff === "off") {
			ctx.ui?.setWidget?.("engine-progress", undefined);
			return;
		}

		if (eff === "lean") {
			ctx.ui?.setWidget?.("engine-progress", undefined);
			ctx.ui?.notify?.(
				`Lean mode active (${index.getStatus().chunkCount} chunks ready in RAM)`,
				"info",
			);
			return;
		}

		const isVectorProfile = eff === "hybrid" || eff === "full";
		const updateWidget = (line: string) => {
			ctx.ui?.setWidget?.("engine-progress", [line], { placement: "belowEditor" });
		};
		const clearWidget = () => {
			ctx.ui?.setWidget?.("engine-progress", undefined);
		};

		const runSync = async () => {
			if (isVectorProfile) {
				updateWidget("\x1b[38;5;244mEngine: Loading embedding model...\x1b[0m");
				await index.preloadModel((msg: string) => {
					updateWidget(`\x1b[38;5;244mEngine: ${msg.slice(0, 40)}\x1b[0m`);
				});
			}
			return await index.syncWorkspace(
				isFullSync,
				(msg: string) => {
					const pctMatch = msg.match(/(\d+)%/);
					if (pctMatch) {
						const pct = parseInt(pctMatch[1], 10);
						const barLen = 16;
						const filled = Math.round((pct / 100) * barLen);
						const empty = barLen - filled;
						const bar =
							"\x1b[38;5;248m" +
							"█".repeat(filled) +
							"\x1b[38;5;238m" +
							"░".repeat(empty) +
							"\x1b[0m";
						updateWidget(
							`\x1b[38;5;244mEngine:\x1b[0m [${bar}] \x1b[38;5;250m${pct}%\x1b[0m \x1b[38;5;242mIndexing workspace\x1b[0m`,
						);
					} else {
						updateWidget(`\x1b[38;5;244mEngine: ${msg.slice(0, 40)}\x1b[0m`);
					}
				},
			);
		};

		// Keep profile changes responsive: model warm-up and indexing run in the
		// existing background lifecycle, while progress remains visible in the UI.
		void runSync()
			.then((result) => {
				clearWidget();
				ctx.ui?.notify?.(
					`Search index ready (${result.chunkCount} chunks in ${result.fileCount} files)`,
					"info",
				);
			})
			.catch((err: any) => {
				clearWidget();
				ctx.ui?.notify?.(`Indexing error: ${err.message}`, "error");
			});
	};

	const setupUnifiedFooter = (ctx: any) => {
		if (ctx.hasUI && ctx.ui?.setFooter) {
			ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
				activeTui = tui;
				const unsubBranch = footerData?.onBranchChange?.(() =>
					tui.requestRender?.(),
				);
				const currentIndex = getSearchIndex(
					ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd(),
				);
				return {
					dispose: () => unsubBranch?.(),
					invalidate: () => {},
					render: (width: number) =>
						renderFooter(ctx, theme, footerData, width, currentIndex),
				};
			});
		}
	};

	pi.registerCommand("repomap", {
		description: "Display the Tree-Sitter AST & PageRank ranked repository map",
		handler: async (args: string, ctx: any) => {
			const budget = args ? parseInt(args, 10) : 1024;
			const map = computeRepoMap(
				ctx.cwd,
				Number.isNaN(budget)
					? getConfig(ctx.cwd).retrieval.repo_map_budget
					: budget,
			);
			ctx.ui?.notify?.("Repository Map Generated", "info");
			if (ctx.hasUI && ctx.ui?.setWidget) {
				ctx.ui.setWidget("repomap-widget", map.split("\n").slice(0, 25));
			} else if (!ctx.hasUI) {
				console.log("\n" + map + "\n");
			}
		},
	});

	// Slash Command: /engine [auto|lean|hybrid|full|off|status|reindex]
	pi.registerCommand("engine", {
		description:
			"Configure codebase retrieval engine (auto | lean | hybrid | full | off | status | reindex)",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{
					value: "status",
					label: "status - Display current engine profile, memory & diagnostics",
				},
				{
					value: "auto",
					label:
						"auto - Auto-detect: Lean (VPS), Hybrid (Laptop), Full (Workstation)",
				},
				{
					value: "lean",
					label:
						"lean - Fast AST-aware BM25 (0% CPU, 0 MB extra RAM) [Persisted Default]",
				},
				{
					value: "hybrid",
					label:
						"hybrid - Throttled 256-dim Matryoshka embeddings [Persisted Default]",
				},
				{
					value: "full",
					label: "full - Multi-core 768-dim embeddings [Persisted Default]",
				},
				{
					value: "off",
					label: "off - Disable search & unload memory [Persisted Default]",
				},
				{ value: "reindex", label: "reindex - Force full workspace re-indexing" },
			];
			const filtered = options.filter((o) =>
				o.value.startsWith(prefix.toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: any) => {
			let sub = (args || "").trim().toLowerCase();
			if (sub.startsWith("default ")) {
				sub = sub.replace("default ", "").trim();
			}
			const index = getSearchIndex(ctx.cwd);

			if (
				sub === "auto" ||
				sub === "lean" ||
				sub === "hybrid" ||
				sub === "full" ||
				sub === "off"
			) {
				index.setProfile(sub as SearchProfile);
				activeTui?.requestRender?.();
				const status = index.getStatus();
				const msg = `Default search profile saved: ${sub.toUpperCase()} (Effective: ${status.effectiveProfile.toUpperCase()})`;
				ctx.ui?.notify?.(msg, "info");
				if (!ctx.hasUI) console.log(`[Codebase Engine] ${msg}`);
				return;
			}

			if (sub === "reindex") {
				ctx.ui?.notify?.("Re-indexing workspace...", "info");
				const res = await index.syncWorkspace(true, (msg) => {
					if (ctx.hasUI) ctx.ui?.notify?.(msg, "info");
				});
				ctx.ui?.notify?.(
					`Indexed ${res.fileCount} files (${res.chunkCount} chunks)`,
					"info",
				);
				if (!ctx.hasUI)
					console.log(
						`[Codebase Engine] Re-indexed ${res.fileCount} files, ${res.chunkCount} chunks.`,
					);
				return;
			}

			if (sub === "status") {
				const status = index.getStatus();
				ctx.ui?.notify?.(
					`Engine: ${status.engineState} | Profile: ${status.profile.toUpperCase()} (${status.effectiveProfile.toUpperCase()}) | Chunks: ${status.chunkCount} | Model: ${status.modelStatus} | RSS: ${status.rssMemoryMB}MB`,
					"info",
				);
				if (!ctx.hasUI) {
					console.log(
						`Codebase Retrieval Engine Status:\n- Engine State: ${status.engineState}\n- Pipeline: ${status.pipelineDesc}\n- Default Profile: ${status.profile.toUpperCase()} (persisted in ~/.pi/agent/search_settings.json)\n- Active Mode: ${status.effectiveProfile.toUpperCase()} (${status.hardwareInfo})\n- Indexed Files: ${status.fileCount}\n- Code Chunks: ${status.chunkCount}\n- Vector Embeddings: ${status.vectorCount}\n- Model Status: ${status.modelStatus}\n- Process RSS: ${status.rssMemoryMB} MB`,
					);
				}
				return;
			}

			// Interactive centered modal dialog with full-viewport backdrop scrim
			if (ctx.hasUI && ctx.ui?.custom) {
				const res: any = await ctx.ui.custom(
					(tui: any, theme: any, _keybindings: any, done: any) =>
						new SearchControlModal(tui, index, theme, done),
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "100%",
						},
					},
				);

				if (res) {
					activeTui?.requestRender?.();
					const eff = index.getEffectiveProfile();
					const profileName = (res.profile || index.getProfile()).toUpperCase();
					const effName = eff.toUpperCase();

					if (res.action === "select") {
						ctx.ui?.notify?.(
							`Engine set to ${profileName} (Effective: ${effName})`,
							"info",
						);
					}

					if (res.reindexed || eff !== "off") {
						triggerBackgroundIndexing(index, ctx, res.action === "reindex");
					} else {
						ctx.ui?.setWidget?.("engine-progress", undefined);
					}
				}
				return;
			}

			// Fallback select menu if custom overlays are unavailable
			if (ctx.hasUI && ctx.ui?.select) {
				const status = index.getStatus();
				const currentProfile = index.getProfile();
				const options = [
					`View Status (${status.engineState} - ${status.chunkCount} chunks, RSS ${status.rssMemoryMB}MB)`,
					`── Profiles ───────────────────────`,
					`Set Default: Auto Detect (Lean -> Hybrid -> Full based on specs)${currentProfile === "auto" ? " [Current]" : ""}`,
					`Set Default: Lean Mode (Fast BM25, 0% CPU, 0 MB extra RAM)${currentProfile === "lean" ? " [Current]" : ""}`,
					`Set Default: Hybrid Mode (Throttled 256-dim Matryoshka)${currentProfile === "hybrid" ? " [Current]" : ""}`,
					`Set Default: Full Mode (768-dim embeddings)${currentProfile === "full" ? " [Current]" : ""}`,
					`Set Default: Disable Engine (Turn off search)${currentProfile === "off" ? " [Current]" : ""}`,
					`── Actions ────────────────────────`,
					`Re-index Workspace`,
				];

				const choice = await ctx.ui.select(
					"Codebase Retrieval Engine Settings",
					options,
				);
				if (!choice || choice.startsWith("──")) return;

				let profileChanged = false;
				let isReindex = false;

				if (choice.includes("Auto Detect")) {
					index.setProfile("auto");
					ctx.ui.notify("Default search profile saved: AUTO", "info");
					profileChanged = true;
				} else if (choice.includes("Lean Mode")) {
					index.setProfile("lean");
					ctx.ui.notify("Default search profile saved: LEAN", "info");
					profileChanged = true;
				} else if (choice.includes("Hybrid Mode")) {
					index.setProfile("hybrid");
					ctx.ui.notify("Default search profile saved: HYBRID", "info");
					profileChanged = true;
				} else if (choice.includes("Full Mode")) {
					index.setProfile("full");
					ctx.ui.notify("Default search profile saved: FULL", "info");
					profileChanged = true;
				} else if (choice.includes("Disable Engine")) {
					index.setProfile("off");
					ctx.ui.notify("Default search profile saved: OFF", "info");
				} else if (choice.includes("Re-index")) {
					isReindex = true;
				} else if (choice.includes("View Status")) {
					const s = index.getStatus();
					ctx.ui.notify(
						`Engine: ${s.engineState} | Profile: ${s.profile.toUpperCase()} (Effective: ${s.effectiveProfile.toUpperCase()}) | Files: ${s.fileCount} | Chunks: ${s.chunkCount} | Model: ${s.modelStatus} | RSS: ${s.rssMemoryMB}MB`,
						"info",
					);
				}

				if (profileChanged || isReindex) {
					triggerBackgroundIndexing(index, ctx, isReindex);
				}
				return;
			}

			// CLI fallback if not in UI mode
			const status = index.getStatus();
			const msg = `Search Status:\n- Engine: ${status.engineState}\n- Profile: ${status.profile} (effective: ${status.effectiveProfile})\n- Indexed Files: ${status.fileCount}\n- Code Chunks: ${status.chunkCount}\n- Vector Embeddings: ${status.vectorCount}\n- Model: ${status.modelStatus}\n- Process RSS: ${status.rssMemoryMB} MB`;
			console.log("\n" + msg + "\n");
		},
	});

	// Slash Command: /lsp (Inspect language servers, active daemons, or install language servers)
	pi.registerCommand("lsp", {
		description:
			"Inspect language servers, active daemons, or install servers (/lsp, /lsp install <lang>)",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{
					value: "status",
					label: "status - View LSP status and active daemon processes",
				},
				{ value: "stop", label: "stop - Stop all active LSP daemon processes" },
				{
					value: "install",
					label:
						"install - Install an LSP server (e.g. pyright, typescript-language-server, gopls, rust-analyzer, clangd)",
				},
			];
			const filtered = options.filter((o) =>
				o.value.startsWith(prefix.toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		async handler(args: string, ctx: any) {
			const sub = args.trim().split(/\s+/);
			const lspMgr = LspManager.getInstance();

			if (sub[0] === "install" && sub[1]) {
				const target = sub[1];
				if (ctx.hasUI && ctx.ui?.notify) {
					ctx.ui.notify(`Installing LSP server for ${target}...`, "info");
				}
				const res = await installLanguageServer(target, (msg) => {
					if (ctx.hasUI && ctx.ui?.notify) {
						ctx.ui.notify(msg, "info");
					}
				});
				if (res.success) {
					ctx.ui?.notify?.(res.message, "info");
				} else {
					ctx.ui?.notify?.(res.message, "error");
				}
				return;
			}

			if (sub[0] === "stop" || sub[0] === "kill") {
				await lspMgr.stopAll();
				ctx.ui?.notify?.("All active LSP servers stopped.", "info");
				return;
			}

			// Interactive centered modal dialog with full-viewport backdrop scrim
			if (ctx.hasUI && ctx.ui?.custom) {
				const res: any = await ctx.ui.custom(
					(tui: any, theme: any, _keybindings: any, done: any) =>
						new LspControlModal(tui, lspMgr, theme, done),
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "100%",
						},
					},
				);

				if (res) {
					if (res.action === "stop") {
						await lspMgr.stopAll();
						ctx.ui?.notify?.("All active LSP servers stopped.", "info");
					} else if (res.installTargets && res.installTargets.length > 0) {
						// Spawn animated ASCII loading spinner modal
						await ctx.ui.custom(
							(tui: any, theme: any, _keybindings: any, done: any) =>
								new LspDownloadModal(tui, res.installTargets, theme, done),
							{
								overlay: true,
								overlayOptions: {
									anchor: "center",
									width: "100%",
								},
							},
						);
					}
				}
				return;
			}

			const activeClients = lspMgr.getStatus();
			if (ctx.hasUI && ctx.ui?.select) {
				const lines = [
					`── Active LSP Daemons (${activeClients.length}) ────────────────`,
					...activeClients.map(
						(c) =>
							`[Active] ${c.languageId.toUpperCase()} (State: ${c.state}, Idle: ${c.idleSeconds}s)`,
					),
					`── Installed / Available Servers ─────────────────────────────`,
					...Object.entries(LSP_SERVERS)
						.slice(0, 10)
						.map(([k, cfg]) => {
							const primaryBin = cfg.commands[0]?.bin;
							const found = findExecutable(primaryBin);
							return `[${found ? "✓" : "✗"}] ${k.padEnd(12)} → ${primaryBin} ${found ? `(${found})` : "(not installed)"}`;
						}),
					`── Actions ───────────────────────────────────────────────────`,
					`Stop all active LSP daemons`,
				];

				const choice = await ctx.ui.select("LSP Server Status & Management", lines);
				if (choice?.includes("Stop all active")) {
					await lspMgr.stopAll();
					ctx.ui.notify("All active LSP servers stopped.", "info");
				}
				return;
			}

			// Console fallback
			let out = `=== LSP Status ===\nActive Daemons: ${activeClients.length}\n`;
			for (const c of activeClients) {
				out += `  • ${c.languageId}: ${c.state} (idle: ${c.idleSeconds}s, root: ${c.rootDir})\n`;
			}
			console.log(out);
		},
	});

	// Background workspace auto-indexer on session startup + setup integrated footer
	pi.on("session_start", async (_event: any, ctx: any) => {
		setupUnifiedFooter(ctx);
		try {
			const index = getSearchIndex(ctx.cwd);
			if (index.getEffectiveProfile() !== "off") {
				index.syncWorkspace(false).catch(() => {});
			}
		} catch (e) {
			kernelDebug(e);
		}
	});

	// 2. Per-session cleanup of the epistemic guard's inspection state and LSP processes.
	// Without this, Map<sessionId, Set<filePath>> grows unbounded over a
	// long-lived process hosting many sessions (e.g. RPC mode). On session
	// shutdown we drop only this session's entry and stop running LSP daemons.
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		const sessionId = getSessionId(ctx);
		globalEpistemicGuard.resetSession(sessionId);
		dedupStore.clearSession(sessionId);
		try {
			await LspManager.getInstance().stopAll();
		} catch (e) {
			kernelDebug(e);
		}
	});

	// 2b. Compaction hooks: bump the dedup store's per-session counter so
	// the next duplicate of any prior content is treated as a new first
	// occurrence. This applies to both auto-triggered and manual compactions.
	pi.on("session_before_compact", async (_event: any, ctx: any) => {
		const sessionId = getSessionId(ctx);
		dedupStore.onCompaction(sessionId);
	});
	pi.on("session_compact", async (_event: any, ctx: any) => {
		const sessionId = getSessionId(ctx);
		dedupStore.onCompaction(sessionId);
	});

	// 4-8. Tools: repo map, AST search, code search, read, edit, LSP
	registerRepoMapTool(pi);
	const invalidateSearchFile = (cwd: string, filePath: string) => {
		getSearchIndex(cwd).invalidateFile(filePath);
	};
	registerAstSearchTool(pi, { getSessionId, getConfig });
	registerCodeSearchTool(pi, { getSessionId, getSearchIndex, getConfig });
	registerReadTool(pi, { getSessionId, getConfig });
	registerEditTool(pi, { getSessionId, getConfig, invalidateSearchFile });
	registerLspTool(pi, { getSessionId, getConfig });
	registerRecallTool(pi, { getSessionId, getDedupStore });

	// 9a. Block host writes before the host tool can create parent directories
	// or overwrite the target. Bash read evidence is recorded after a successful
	// command result below; preflight classification alone is not a read.
	pi.on("tool_call", async (event: any, ctx: any) => {
		try {
			const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
			const sessionId = getSessionId(ctx);
			if (event.toolName !== "write") return;
			const targetPath = (event.input as any)?.path;
			if (typeof targetPath !== "string" || !targetPath.trim()) {
				return {
					block: true,
					reason: "[WRITE ERROR] Missing target path.",
				};
			}
			const config = getConfig(cwd);
			const resolvedPath = resolveUserPath(targetPath, cwd);
			const check = globalEpistemicGuard.checkReadPrecondition(
				resolvedPath,
				"write",
				sessionId,
				cwd,
				config.safety.enable_epistemic_guard,
			);
			if (!check.allowed) {
				// Block only this write. The model must remain able to inspect the
				// rejection and choose a safe workaround or ask for clarification.
				return {
					block: true,
					reason: check.reason,
				};
			}
		} catch (e) {
			kernelDebug(e);
			if (event.toolName === "write") {
				return {
					block: true,
					reason: `[WRITE BLOCKED] Safety preflight failed closed: ${e instanceof Error ? e.message : String(e)}`,
				};
			}
		}
	});

	// 9. Tool Result Interceptor: Syntax Validation & Output Clamping (ACI)
	pi.on("tool_result", async (event: any, ctx: any) => {
		if (event.isError) return;

		const toolName = event.toolName;
		// resultContent === undefined means "no transformation, return event.content as-is".
		// A non-undefined value is the content the LLM will see; the dedup check
		// at the end runs on whichever form is set.
		let resultContent: any = undefined;
		let didBail = false;

		// 9a. Intercept bash & terminal output to clamp minified lines & massive match floods
		if (toolName === "bash") {
			const command = (event.input as any)?.command || "";
			const outputConfig = getConfig(
				ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd(),
			);
			let bashOutputComplete = true;
			resultContent = (event.content || []).map((c: any) => {
				if (c.type === "text" && typeof c.text === "string") {
					const clamped = clampCommandOutput(c.text, command, {
						maxLineLength: outputConfig.safety.max_line_length,
						maxLines: outputConfig.safety.max_lines,
						maxTotalBytes: outputConfig.safety.max_total_bytes,
					});
					if (clamped.truncated) {
						bashOutputComplete = false;
						return { ...c, text: clamped.text };
					}
				}
				return c;
			});
			globalEpistemicGuard.recordCommandExecution(
				command,
				ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd(),
				getSessionId(ctx),
				bashOutputComplete,
				(resultContent || [])
					.filter((c: any) => c.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join(""),
			);
		}

		// 9b. Preserve the host write-tool compatibility path. The custom edit
		// tool owns its complete verification lifecycle; intercepting edit results
		// here would duplicate syntax/LSP work.
		if (toolName === "write") {
			const input = event.input as any;
			const targetPath = input?.path;

			// The harness does not reliably propagate result-level isError to this
			// hook, so a failed edit can still reach here. Detect the edit tool's
			// failure markers and bail out before post-write checks.
			const resultText = (event.content || [])
				.map((c: any) =>
					c.type === "text" && typeof c.text === "string" ? c.text : "",
				)
				.join("\n");
			if (
				resultText.includes("[EDIT FAILED]") ||
				resultText.includes("[EDIT ERROR]") ||
				resultText.includes("[EPISTEMIC GUARD REJECTION]") ||
				resultText.includes("[READ ERROR]")
			) {
				didBail = true;
			} else if (targetPath) {
				const resultCwd =
					ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
				const resolvedPath = resolveUserPath(targetPath, resultCwd);
				getSearchIndex(resultCwd).invalidateFile(resolvedPath);
				const syntaxRes = checkSyntax(resolvedPath);

				if (!syntaxRes.valid && syntaxRes.status === "failed") {
					const warning = `\n\n[SYNTAX WARNING] ${syntaxRes.error}\nPlease fix this syntax error.`;
					resultContent = event.content.map((c: any) =>
						c.type === "text" ? { ...c, text: c.text + warning } : c,
					);
				} else {
					// Synchronize with active LSP daemon and fetch post-edit diagnostics if available
					let lspNotice = "";
					try {
						const lspMgr = LspManager.getInstance();
						const client = lspMgr.getReadyClientForFile(resolvedPath, resultCwd);
						if (client && client.getState() === "ready") {
							const fileContent = fs.readFileSync(resolvedPath, "utf8");
							await client.changeDocument(resolvedPath, fileContent);
							await client.saveDocument(resolvedPath, fileContent);

							// Allow LSP server brief window to compute diagnostics
							const diagnostics = await client.getDiagnosticsResult(resolvedPath);
							if (diagnostics.diagnostics.length > 0) {
								const formattedDiags = formatDiagnostics(
									diagnostics.diagnostics,
									resolvedPath,
									resultCwd,
								);
								lspNotice = `\n\n[LSP Diagnostics]\n${formattedDiags}`;
							} else if (diagnostics.status !== "clean") {
								lspNotice = `\n\n[LSP ${diagnostics.status.toUpperCase()}] No definitive diagnostics result.`;
							}
						}
					} catch (e) {
						kernelDebug(e);
					}

					if (lspNotice) {
						resultContent = event.content.map((c: any) =>
							c.type === "text" ? { ...c, text: c.text + lspNotice } : c,
						);
					}
				}
			}
		}

		// 9c. Dedup pass: hash the rendered text + tool name + input params;
		// if it's a byte-equal duplicate (same tool, same params, same text)
		// of one already in this session's current (uncompacted) context,
		// replace with a [=rN,sizeB,tool,paramsKey] reference. Bail
		// branches (didBail) skip dedup; errors are filtered at the top.
		// The `recall` tool is exempt: its entire purpose is to break the
		// dedup chain by emitting the original bytes; if we dedup'd its
		// output, the LLM would get a reference instead of the bytes it
		// asked for.
		if (!didBail && toolName !== "recall") {
			const contentForLLM = resultContent !== undefined ? resultContent : (event.content || []);
			const hasOnlyTextContent = (contentForLLM as any[]).every(
				(c: any) => c.type === "text" && typeof c.text === "string",
			);
			const finalText = hasOnlyTextContent
				? (contentForLLM as any[]).map((c: any) => c.text).join("")
				: "";
			if (hasOnlyTextContent && Buffer.byteLength(finalText, "utf8") > 0) {
				const sessionId = getSessionId(ctx);
				const compactionCounter = dedupStore.getCompactionCounter(sessionId);
				const inputParams = event.input || {};
				const decision = dedupStore.record(
					sessionId,
					event.toolCallId || "",
					toolName,
					inputParams,
					finalText,
					false,
					compactionCounter,
				);
				if (decision.isDuplicate) {
					// Recall the prior entry's metadata so the notice names
					// the tool and paramsKey. The LLM can use this to
					// decide whether to recall or run a fresh tool call.
					const prior = dedupStore.get(sessionId, decision.shortRef);
					const priorTool = prior?.toolName ?? toolName;
					const priorParamsKey = prior?.paramsKey ?? "";
					resultContent = [
						{
							type: "text",
							text: `[=${decision.shortRef},${Buffer.byteLength(finalText, "utf8")}B,${priorTool},${priorParamsKey}]`,
						},
					];
				}
				// For first occurrence, the dedup store has the entry, but we
				// don't need to return anything; Pi will use event.content as-is.
			}
		}

		if (didBail) return;
		if (resultContent !== undefined) {
			return { content: resultContent };
		}
	});

	// 10. Dynamic Runtime Context Injection (Repo Map with in-memory caching)
	// Notice: Custom user instructions (AGENT.md / prompt templates) are respected as the primary authority.
	// Only runtime operational metadata (repo map) is dynamically attached and cached per session/cwd.
	let cachedRepoMap = "";
	let cachedRepoMapCwd = "";
	let lastRepoMapCheck = 0;

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const now = Date.now();
		const currentCwd = ctx.cwd || process.cwd();

		// Cache repo-map across turns with a 15-second TTL to avoid scanning/PageRanking entire repo on every turn
		if (!cachedRepoMap || cachedRepoMapCwd !== currentCwd || now - lastRepoMapCheck > 15000) {
			cachedRepoMap = computeRepoMap(
				currentCwd,
				getConfig(currentCwd).retrieval.repo_map_budget,
			);
			cachedRepoMapCwd = currentCwd;
			lastRepoMapCheck = now;
		}

		const dedupNote = `\nA [=rN,sizeB,tool,paramsKey] reference means the identical result was already provided earlier in this session. It is informational, not an instruction to call recall. Use recall only when the exact content is needed and is no longer visible. For a different range, symbol, or query, run a fresh tool call.\n`;

		const runtimeContext = `
## Available Repository Context:
${cachedRepoMap}
${dedupNote}
`;
		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${runtimeContext}`
				: runtimeContext,
		};
	});
}
