import * as path from "path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeRepoMap } from "./retrieval/repomap";
import { HybridSearchIndex } from "./retrieval/search_index";
import type { SearchProfile } from "./retrieval/search_config";
import { SearchControlModal } from "./retrieval/search_modal";
import {
	checkSyntax,
	autoCommitFile,
	undoLastCommit,
} from "./editing/git-verify";
import { globalEpistemicGuard } from "./safety/epistemic_guard";
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
import {
	clampCommandOutput,
	isDiscoveryCommand,
} from "./safety/output_clamper";
import { runOracle } from "./safety/test_oracle";
import { registerCustomCompaction } from "./context/compaction_enhanced";
import { sanitizeSessionFiles } from "./context/session_repair";
import { renderFooter } from "./ui/footer";
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

	// 1. Enhanced Compaction Hook (session_before_compact)
	registerCustomCompaction(pi);

	// 3. Slash Commands: /repomap, /undo, /oracle, /search, /engine
	let activeTui: any = null;
	let searchIndex: HybridSearchIndex | null = null;
	const getSearchIndex = (cwd: string) => {
		if (!searchIndex) {
			searchIndex = new HybridSearchIndex(cwd);
		}
		return searchIndex;
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
				isFullSync || isVectorProfile,
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

	pi.registerCommand("oracle", {
		description:
			"Run deterministic test/type-check verification oracle (/oracle [test-command])",
		handler: async (args: string, ctx: any) => {
			const cmd = args?.trim() || "npx tsx test.ts";
			ctx.ui?.notify?.(`Executing Test Oracle: '${cmd}'...`, "info");
			const result = await runOracle(cmd, { cwd: ctx.cwd });
			const notifyType = result.passed ? "info" : "error";
			ctx.ui?.notify?.(result.summary, notifyType);
			if (!ctx.hasUI) {
				console.log(`\n${result.summary}\n${result.output}\n`);
			}
		},
	});

	pi.registerCommand("repomap", {
		description: "Display the Tree-Sitter AST & PageRank ranked repository map",
		handler: async (args: string, ctx: any) => {
			const budget = args ? parseInt(args, 10) : 1024;
			const map = computeRepoMap(ctx.cwd, isNaN(budget) ? 1024 : budget);
			ctx.ui?.notify?.("Repository Map Generated", "info");
			if (ctx.hasUI && ctx.ui?.setWidget) {
				ctx.ui.setWidget("repomap-widget", map.split("\n").slice(0, 25));
			} else if (!ctx.hasUI) {
				console.log("\n" + map + "\n");
			}
		},
	});

	pi.registerCommand("undo", {
		description: "Undo the last automated git commit or edit",
		handler: async (_args: string, ctx: any) => {
			const res = undoLastCommit(ctx.cwd);
			if (res.success) {
				ctx.ui?.notify?.(res.message, "info");
			} else {
				ctx.ui?.notify?.(res.message, "error");
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

	// 2. Per-session cleanup of the epistemic guard's inspection state.
	// Without this, Map<sessionId, Set<filePath>> grows unbounded over a
	// long-lived process hosting many sessions (e.g. RPC mode). On session
	// shutdown we drop only this session's entry; all other sessions keep
	// their state intact.
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		const sessionId = getSessionId(ctx);
		globalEpistemicGuard.resetSession(sessionId);
	});

	// 4-8. Tools: repo map, AST search, code search, read, edit, LSP
	registerRepoMapTool(pi);
	registerAstSearchTool(pi, { getSessionId });
	registerCodeSearchTool(pi, { getSessionId, getSearchIndex });
	registerReadTool(pi, { getSessionId });
	registerEditTool(pi, { getSessionId });
	registerLspTool(pi);

	// 9a-pre. Record file inspections from bash command during preflight.
	// Must run in tool_call (not tool_result) so the file is recorded before
	// the edit's execute runs its guard check. In pi's default parallel tool
	// mode, tool_call hooks for sibling tools fire sequentially before any
	// tool executes, so a bash `cat foo.ts` will be recorded before a sibling
	// edit on the same file runs its guard.
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.toolName !== "bash") return;
		const command = (event.input as any)?.command || "";
		if (!command) return;
		try {
			globalEpistemicGuard.recordCommandExecution(
				command,
				ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd(),
				getSessionId(ctx),
			);
		} catch (e) {
			kernelDebug(e);
		}
	});

	// 9. Tool Result Interceptor: Syntax Validation, Auto-Commit, & Output Clamping (ACI)
	pi.on("tool_result", async (event: any, ctx: any) => {
		if (event.isError) return;

		const toolName = event.toolName;

		// 9a. Intercept bash & terminal output to clamp minified lines & massive match floods
		if (toolName === "bash") {
			const command = (event.input as any)?.command || "";

			// Note: file inspections from bash are now recorded in the tool_call
			// preflight hook above, so the file is in the guard before any sibling
			// edit's execute runs its check.

			const isSearch = isDiscoveryCommand(command);

			const updatedContent = (event.content || []).map((c: any) => {
				if (c.type === "text" && typeof c.text === "string") {
					const clamped = clampCommandOutput(c.text, command, {
						maxLineLength: 300,
						maxLines: isSearch ? 40 : 100,
						maxTotalBytes: isSearch ? 15 * 1024 : 30 * 1024,
					});
					if (clamped.truncated) {
						return { ...c, text: clamped.text };
					}
				}
				return c;
			});

			return {
				content: updatedContent,
			};
		}

		// 9b. Preserve the host write-tool compatibility path. The custom edit
		// tool owns its complete verification and commit lifecycle; intercepting
		// edit results here would duplicate syntax/LSP/commit work.
		if (toolName === "write") {
			const input = event.input as any;
			const targetPath = input?.path;

			// The harness does not reliably propagate result-level isError to this
			// hook, so a FAILED edit can still reach here. Committing then would
			// stage untracked files wholesale under a misleading "pi: edit <file>"
			// message even though nothing was applied. Detect the edit tool's
			// failure markers in the result text and bail out before committing.
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
				return;
			}

			if (targetPath) {
				const resolvedPath = path.isAbsolute(targetPath)
					? targetPath
					: path.resolve(ctx.cwd, targetPath);
				const syntaxRes = checkSyntax(resolvedPath);

				if (!syntaxRes.valid) {
					const warning = `\n\n[SYNTAX WARNING] ${syntaxRes.error}\nPlease fix this syntax error.`;
					const updatedContent = event.content.map((c: any) =>
						c.type === "text" ? { ...c, text: c.text + warning } : c,
					);
					return {
						content: updatedContent,
					};
				}

				// Synchronize with active LSP daemon and fetch post-edit diagnostics if available
				let lspNotice = "";
				try {
					const lspMgr = LspManager.getInstance();
					const client = await lspMgr.getClientForFile(resolvedPath, ctx.cwd);
					if (client && client.getState() === "ready") {
						const fileContent = fs.readFileSync(resolvedPath, "utf8");
						await client.changeDocument(resolvedPath, fileContent);
						await client.saveDocument(resolvedPath, fileContent);

						// Allow LSP server brief window to compute diagnostics
						const diags = await client.getDiagnostics(resolvedPath);
						if (diags && diags.length > 0) {
							const formattedDiags = formatDiagnostics(diags, resolvedPath, ctx.cwd);
							lspNotice = `\n\n[LSP Diagnostics]\n${formattedDiags}`;
						}
					}
				} catch (e) {
					kernelDebug(e);
				}

				// Auto-commit valid edit
				const commitMsg = `pi: ${toolName} ${path.basename(resolvedPath)}`;
				autoCommitFile(ctx.cwd, resolvedPath, commitMsg);

				if (lspNotice) {
					const updatedContent = event.content.map((c: any) =>
						c.type === "text" ? { ...c, text: c.text + lspNotice } : c,
					);
					return {
						content: updatedContent,
					};
				}
			}
		}
	});

	// 10. Dynamic Runtime Context Injection (Repo Map)
	// Notice: Custom user instructions (AGENT.md / prompt templates) are respected as the primary authority.
	// Only runtime operational metadata (repo map) is dynamically attached.
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const repoMap = computeRepoMap(ctx.cwd, 512);

		const runtimeContext = `
## Available Repository Context:
${repoMap}
`;
		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${runtimeContext}`
				: runtimeContext,
		};
	});
}
