import * as path from "path";
import * as fs from "node:fs";
import * as child_process from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeRepoMap, evaluateCodebaseMetrics } from "./retrieval/repomap";
import { HybridSearchIndex } from "./retrieval/search_index";
import type { SearchProfile } from "./retrieval/search_config";
import { SearchControlModal } from "./retrieval/search_modal";
import { checkSyntax } from "./editing/syntax-verify";
import {
	globalEpistemicGuard,
	resolveUserPath,
} from "./safety/epistemic_guard";
import { loadKernelConfig, registerAgentKernelCommand } from "./config";
import { kernelDebug } from "./safety/kernel_debug";
import { registerRepoMapTool } from "./tools/repo_map_tool";
import { registerAstSearchTool } from "./tools/ast_search_tool";
import { registerCodeSearchTool } from "./tools/code_search_tool";
import { registerReadTool } from "./tools/read_tool";
import { registerEditTool } from "./tools/edit_tool";
import { registerLspTool } from "./tools/lsp_tool";
import { TreeSitterEngine } from "./retrieval/tree_sitter_engine";

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

const PI_DOCS_START =
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const PI_DOCS_END = /\n- Always read pi \.md files completely[^\n]*/;
const KERNEL_GUIDANCE_MARKER = "## Agent Kernel Guidance";
let kernelGuidance: string | null | undefined;
const piDocsEnabledBySession = new Map<string, boolean>();
const codebaseProfileBySession = new Map<string, "auto" | "light" | "heavy">();

function withoutPiDocumentation(systemPrompt: string): string {
	const start = systemPrompt.indexOf(PI_DOCS_START);
	if (start < 0) return systemPrompt;
	const endMatch = systemPrompt.slice(start).match(PI_DOCS_END);
	if (!endMatch || endMatch.index === undefined) return systemPrompt;

	const end = start + endMatch.index + endMatch[0].length;
	const before = systemPrompt.slice(0, start).replace(/\n{2,}$/, "\n");
	const after = systemPrompt.slice(end).replace(/^\n{2,}/, "\n");
	return before + after;
}

function piDocsEnabled(ctx: any): boolean {
	const sessionVal = piDocsEnabledBySession.get(getSessionId(ctx));
	if (sessionVal !== undefined) return sessionVal;
	const cwd = ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd();
	return loadKernelConfig(cwd).instructions.pi_docs ?? true;
}

function loadKernelGuidance(): string {
	if (kernelGuidance !== undefined) return kernelGuidance ?? "";

	try {
		const instructionPath = path.join(__dirname, "..", "AGENT_KERNEL_SYS_PROMPT.md");
		const contents = fs.readFileSync(instructionPath, "utf8").trim();
		kernelGuidance = contents || null;
	} catch (error) {
		kernelGuidance = null;
		kernelDebug(error);
	}

	return kernelGuidance ?? "";
}

function appendKernelGuidance(systemPrompt: string, guidance: string): string {
	if (!guidance || systemPrompt.includes(guidance)) return systemPrompt;
	const base = systemPrompt.trimEnd();
	return `${base ? `${base}\n\n` : ""}${KERNEL_GUIDANCE_MARKER}\n${guidance}`;
}
import { clampCommandOutput } from "./safety/output_clamper";
import { sanitizeSessionFiles } from "./context/session_repair";
import { formatSearchEngineTag, renderFooter } from "./ui/footer";
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
	// Initialize TreeSitter WASM engine eagerly in background
	TreeSitterEngine.getInstance().init().catch((err) => {
		kernelDebug(`TreeSitter background init error: ${err}`);
	});

	// 0. Auto-Sanitize Session Files (Repairs pre-existing incomplete usage metadata)
	try {
		sanitizeSessionFiles();
	} catch (e) {
		kernelDebug(e);
	}

	// 3. Slash Commands: /repomap, /engine, /lsp, /pi-docs
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

	// Helper: Background index synchronization with statusline indicator
	const syncRetrievalStatus = (ctx: any, customText?: string) => {
		if (!ctx?.ui?.setStatus) return;
		const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
		const index = getSearchIndex(cwd);
		const eff = index.getEffectiveProfile();
		if (eff === "off") {
			ctx.ui.setStatus("retrieval", "");
			activeTui?.requestRender?.();
			return;
		}

		if (customText !== undefined) {
			ctx.ui.setStatus("retrieval", customText);
		} else {
			const tag = formatSearchEngineTag(index, true);
			ctx.ui.setStatus("retrieval", tag);
		}
		activeTui?.requestRender?.();
	};

	const triggerBackgroundIndexing = (
		index: HybridSearchIndex,
		ctx: any,
		isFullSync = false,
	) => {
		const eff = index.getEffectiveProfile();
		if (eff === "off") {
			syncRetrievalStatus(ctx);
			return;
		}

		const engineTag = formatSearchEngineTag(index, true);
		const streamArrow = "\x1b[38;2;155;210;170m⇢\x1b[0m";
		syncRetrievalStatus(
			ctx,
			`${engineTag} ${streamArrow} \x1b[38;2;165;175;190m(indexing...)\x1b[0m`,
		);

		const runSync = async () => {
			return await index.syncWorkspace(
				isFullSync,
				(msg: string) => {
					const pctMatch = msg.match(/(\d+)%/);
					const speedMatch = msg.match(/([\d.]+\s*chunk\/s)/);
					const countMatch = msg.match(/\((\d+)\/(\d+)/);

					if (pctMatch) {
						const pct = parseInt(pctMatch[1], 10);
						let info = "";
						if (countMatch && speedMatch) {
							info = ` \x1b[38;2;165;175;190m(${countMatch[1]}/${countMatch[2]} • ${speedMatch[1]})\x1b[0m`;
						} else if (countMatch) {
							info = ` \x1b[38;2;165;175;190m(${countMatch[1]}/${countMatch[2]})\x1b[0m`;
						} else if (msg.includes("Downloading")) {
							info = ` \x1b[38;2;165;175;190m(downloading weights)\x1b[0m`;
						}

						syncRetrievalStatus(
							ctx,
							`${engineTag} ${streamArrow} \x1b[38;2;155;210;170m${pct}%\x1b[0m${info}`,
						);
					} else {
						syncRetrievalStatus(
							ctx,
							`${engineTag} ${streamArrow} \x1b[38;2;165;175;190m(${msg.slice(0, 35)})\x1b[0m`,
						);
					}
				},
			);
		};

		// Keep profile changes responsive: indexing runs in the background
		// while progress stays cleanly reported on the statusline.
		void runSync()
			.then((result) => {
				syncRetrievalStatus(ctx); // Reset to clean idle tag on status line
				if (
					(result.indexedCount !== undefined ? result.indexedCount > 0 : false) ||
					isFullSync
				) {
					ctx.ui?.notify?.(
						`Search index ready (${result.chunkCount} chunks in ${result.fileCount} files)`,
						"info",
					);
				}
			})
			.catch((err: any) => {
				syncRetrievalStatus(ctx);
				ctx.ui?.notify?.(`Indexing error: ${err.message}`, "error");
			});
	};

	const setupUnifiedFooter = (ctx: any) => {
		syncRetrievalStatus(ctx);
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

	registerAgentKernelCommand(pi, {
		getConfig,
		invalidateConfig: (cwd) => {
			configByWorkspace.delete(path.resolve(cwd));
		},
		clearCaches: () => {
			cachedRepoMap = "";
		},
	});

	pi.registerCommand("pi-docs", {
		description: "Toggle Pi documentation guidance in the system prompt",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "on", label: "on - Include Pi documentation guidance" },
				{ value: "off", label: "off - Omit Pi documentation guidance" },
				{ value: "status", label: "status - Show the current setting" },
			];
			const filtered = options.filter((option) =>
				option.value.startsWith(prefix.toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: any) => {
			const sessionId = getSessionId(ctx);
			const value = (args || "").trim().toLowerCase();
			if (value === "on" || value === "off") {
				piDocsEnabledBySession.set(sessionId, value === "on");
				ctx.ui?.notify?.(
					`Pi documentation guidance ${value === "on" ? "enabled" : "disabled"} for this session.`,
					"info",
				);
				return;
			}

			const enabled = piDocsEnabled(ctx);
			const message = `Pi documentation guidance: ${enabled ? "on" : "off"}`;
			ctx.ui?.notify?.(message, "info");
			if (!ctx.hasUI) console.log(message);
		},
	});

	pi.registerCommand("repomap", {
		description: "Display the Tree-Sitter AST & PageRank ranked repository map",
		handler: async (args: string, ctx: any) => {
			await TreeSitterEngine.getInstance().init();
			const budget = args ? parseInt(args, 10) : 1024;
			const map = computeRepoMap(
				ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd(),
				Number.isNaN(budget)
					? getConfig(ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd()).retrieval.repo_map_budget
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

	// Slash Command: /profile [auto|smart|light|heavy|status]
	pi.registerCommand("profile", {
		description: "Configure codebase scale profile (auto/smart | light | heavy | status)",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "auto", label: "auto (smart) - Auto-detect scale from codebase metrics" },
				{ value: "light", label: "light - Force light profile (suppress auto repo-map)" },
				{ value: "heavy", label: "heavy - Force heavy profile (always inject repo-map)" },
				{ value: "status", label: "status - Display current profile & codebase metrics" },
			];
			const filtered = options.filter((o) => o.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: any) => {
			const sessionId = getSessionId(ctx);
			const raw = (args || "").trim().toLowerCase();
			const val = raw === "smart" ? "auto" : raw;

			if (val === "auto" || val === "light" || val === "heavy") {
				codebaseProfileBySession.set(sessionId, val);
				cachedRepoMap = "";
				const msg = `Codebase profile set to '${val}' for this session.`;
				ctx.ui?.notify?.(msg, "info");
				if (!ctx.hasUI) console.log(msg);
				return;
			}

			const currentCwd = ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd();
			const current = codebaseProfileBySession.get(sessionId) ?? getConfig(currentCwd).retrieval.codebase_profile;
			const metrics = evaluateCodebaseMetrics(currentCwd);
			const detected = metrics.isLight ? "light" : "heavy";
			const effective = current === "auto" ? detected : current;
			const statusMsg = `Profile: ${current} (effective: ${effective})\nMetrics: ${metrics.implFiles} impl files (${Math.round(metrics.implBytes / 1024)} KB), ${metrics.testFiles} test files (${Math.round(metrics.testBytes / 1024)} KB)`;
			ctx.ui?.notify?.(statusMsg, "info");
			if (!ctx.hasUI) console.log("\n" + statusMsg + "\n");
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
						"hybrid - Throttled 256-dim Matryoshka embeddings",
				},
				{
					value: "full",
					label: "full - Multi-core 768-dim embeddings",
				},
				{
					value: "off",
					label: "off - Disable search & unload memory",
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
			const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
			const index = getSearchIndex(cwd);
			if (index.getEffectiveProfile() !== "off") {
				triggerBackgroundIndexing(index, ctx, false);
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
		piDocsEnabledBySession.delete(sessionId);
		globalEpistemicGuard.resetSession(sessionId);
		try {
			await LspManager.getInstance().stopAll();
		} catch (e) {
			kernelDebug(e);
		}
		// Flush any debounced search index writes to disk on shutdown and halt further admissions
		for (const index of searchIndexes.values()) {
			try {
				await index.flushPendingSave(true);
			} catch (e) {
				kernelDebug(e);
			}
		}
	});

	// 4-8. Tools: Core tools (read, edit) and code_search are registered.
	// Speculative AST dump and heavy daemon tools (ast_search, repo_map, lsp) remain optional
	// to avoid prompt bloat on routine tasks.
	const invalidateSearchFile = (cwd: string, filePath: string) => {
		const index = getSearchIndex(cwd);
		void index.updateFile(filePath).catch((err) => {
			kernelDebug(`Incremental updateFile error for ${filePath}: ${err}`);
		});
	};
	registerReadTool(pi, { getSessionId, getConfig });
	registerEditTool(pi, { getSessionId, getConfig, invalidateSearchFile });
	registerCodeSearchTool(pi, { getSessionId, getSearchIndex, getConfig });

	const enableSpeculativeTools = process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS === "1" ||
		process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS === "true" ||
		getConfig(process.cwd()).retrieval.enable_tools === true;

	if (enableSpeculativeTools) {
		registerRepoMapTool(pi);
		registerAstSearchTool(pi, { getSessionId, getConfig });
		registerLspTool(pi, { getSessionId, getConfig });
	}

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
		const isShell = event.toolName === "bash" || event.toolName === "powershell";
		if (event.isError && !isShell) return;

		// resultContent === undefined means "no transformation, return event.content as-is".
		const toolName = event.toolName;
		let resultContent: any = undefined;
		let didBail = false;

		// 9a. Intercept bash & powershell output to clamp minified lines & massive match floods
		if (toolName === "bash" || toolName === "powershell") {
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
			if (event.isError) {
				return resultContent !== undefined
					? { content: resultContent, isError: true }
					: undefined;
			}
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
				void getSearchIndex(resultCwd).updateFile(resolvedPath).catch((err) => {
					kernelDebug(`Incremental updateFile error for ${resolvedPath}: ${err}`);
				});

				// Update epistemic guard ledger with the newly written file
				try {
					if (fs.existsSync(resolvedPath)) {
						const writtenContent = fs.readFileSync(resolvedPath, "utf8");
						globalEpistemicGuard.recordFileMutation(
							resolvedPath,
							getSessionId(ctx),
							resultCwd,
							writtenContent,
							{ complete: true },
						);
					}
				} catch (e) {
					kernelDebug(e);
				}

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

		if (didBail) return;
		if (resultContent !== undefined) {
			return { content: resultContent };
		}
	});

	// 10. Dynamic Runtime Context Injection (Repo Map with in-memory caching & Turn 1 Grounding)
	// Notice: Custom user instructions (AGENT.md / prompt templates) are respected as the primary authority.
	// Only runtime operational metadata (repo map) is dynamically attached and cached per session/cwd.
	let cachedRepoMap = "";
	let cachedRepoMapCwd = "";
	let lastRepoMapCheck = 0;
	const sessionGroundingDone = new Set<string>();
	const sessionGroundingText = new Map<string, string>();

	function getPreFlightGrounding(cwd: string, sessionId: string): string {
		if (sessionGroundingDone.has(sessionId)) {
			return sessionGroundingText.get(sessionId) || "";
		}
		sessionGroundingDone.add(sessionId);

		try {
			const statusRaw = child_process.execFileSync(
				"git",
				["status", "--porcelain"],
				{ cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 },
			).trim();

			if (!statusRaw) {
				sessionGroundingText.set(sessionId, "");
				return "";
			}

			let diffRaw = "";
			try {
				diffRaw = child_process.execFileSync(
					"git",
					["diff", "HEAD", "-U3"],
					{ cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
				).trim();
			} catch {
				try {
					diffRaw = child_process.execFileSync(
						"git",
						["diff", "-U3"],
						{ cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
					).trim();
				} catch {
					diffRaw = "";
				}
			}

			if (!diffRaw && !statusRaw) {
				sessionGroundingText.set(sessionId, "");
				return "";
			}

			const statusLines = statusRaw.split("\n").slice(0, 8).join("\n");
			const lines = diffRaw.split("\n");
			const maxLines = 25;
			const maxDiffBytes = 2048;
			let clampedDiff = lines.slice(0, maxLines).join("\n");
			let wasByteTruncated = false;
			if (Buffer.byteLength(clampedDiff, "utf8") > maxDiffBytes) {
				const buf = Buffer.from(clampedDiff, "utf8").subarray(0, maxDiffBytes);
				clampedDiff = new TextDecoder("utf-8", { fatal: false }).decode(buf);
				if (/[\uD800-\uDBFF]$/.test(clampedDiff)) {
					clampedDiff = clampedDiff.slice(0, -1);
				}
				wasByteTruncated = true;
			}
			const truncatedNotice = lines.length > maxLines || wasByteTruncated
				? `\n[... diff truncated; inspect test file via read() ...]`
				: "";

			const safeStatus = statusLines.replace(/```/g, "'''");
			const safeDiff = clampedDiff.replace(/```/g, "'''");

			const grounding = [
				"## Workspace Pre-Flight (Reproduction Status):",
				"<!-- Passive environment context; not instruction -->",
				"```git-status",
				safeStatus,
				"```",
				safeDiff ? `\`\`\`diff\n${safeDiff}\n\`\`\`${truncatedNotice}` : "",
			].filter(Boolean).join("\n");

			sessionGroundingText.set(sessionId, grounding);
			return grounding;
		} catch (error) {
			kernelDebug(error);
			sessionGroundingText.set(sessionId, "");
			return "";
		}
	}

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const now = Date.now();
		const currentCwd = ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd();
		const kernelConfig = getConfig(currentCwd);
		const sessionId = getSessionId(ctx);
		const profile = codebaseProfileBySession.get(sessionId) ?? kernelConfig.retrieval.codebase_profile ?? "auto";

		let shouldInjectMap = false;
		// Disabled automatic AST repo map injection to evaluate prompt token footprint and latency
		// The `get_repo_map` tool remains available on-demand.

		// Cache repo-map across turns with a 15-second TTL to avoid scanning/PageRanking entire repo on every turn
		if (!cachedRepoMap || cachedRepoMapCwd !== currentCwd || now - lastRepoMapCheck > 15000) {
			if (shouldInjectMap) {
				await TreeSitterEngine.getInstance().init();
				cachedRepoMap = computeRepoMap(
					currentCwd,
					kernelConfig.retrieval.repo_map_budget,
				);
			} else {
				cachedRepoMap = "";
			}
			cachedRepoMapCwd = currentCwd;
			lastRepoMapCheck = now;
		}

		const preFlightDiff = getPreFlightGrounding(currentCwd, sessionId);
		const runtimeParts = [
			cachedRepoMap ? `## Available Repository Context:\n${cachedRepoMap}` : "",
			preFlightDiff,
		].filter(Boolean);
		const runtimeContext = runtimeParts.length > 0 ? `\n${runtimeParts.join("\n\n")}\n` : "";

		const basePrompt = event.systemPrompt || "";
		const systemPrompt = piDocsEnabled(ctx)
			? basePrompt
			: withoutPiDocumentation(basePrompt);
		const guidance = kernelConfig.instructions.enabled
			? loadKernelGuidance()
			: "";
		const guidedPrompt = appendKernelGuidance(systemPrompt, guidance);
		const shouldAppendRuntime = runtimeContext && !guidedPrompt.includes(runtimeContext.trim());
		return {
			systemPrompt: guidedPrompt
				? (shouldAppendRuntime ? `${guidedPrompt}\n\n${runtimeContext}` : guidedPrompt)
				: runtimeContext,
		};
	});
}
