import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HybridSearchIndex } from "./retrieval/search_index";
import { type SearchProfile, savePersistedProfile } from "./retrieval/search_config";
import { SearchControlModal } from "./retrieval/search_modal";
import { checkSyntax } from "./editing/syntax-verify";
import {
	globalEpistemicGuard,
	resolveUserPath,
} from "./safety/epistemic_guard";
import { loadKernelConfig, registerAgentKernelCommand, saveProjectKernelConfig } from "./config";
import { kernelDebug } from "./safety/kernel_debug";
import { registerCodeSearchTool } from "./tools/code_search_tool";
import { registerReadTool } from "./tools/read_tool";
import { registerEditTool } from "./tools/edit_tool";
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

const PI_DOCS_TAGGED = /\n?<docs>\s*\nPi documentation \(read only when the user asks about [^)]+\):[\s\S]*?<\/docs>\r?\n?/;
const PI_DOCS_START =
	/Pi documentation \(read only when the user asks about (?:pi|the harness) itself, its SDK, extensions, themes, skills, or TUI\):/;
const PI_DOCS_END =
	/\n- (?:Always read pi \.md files completely|Before implementing harness changes, read the relevant docs)[^\n]*/;
export const KERNEL_GUIDANCE_MARKER = "<agent_kernel_guidance>";
const KERNEL_TOOL_BLOCKS = ["CODE_SEARCH"] as const;
let kernelGuidance: string | null | undefined;
const piDocsEnabledBySession = new Map<string, boolean>();
const lastNotifiedProfileBySession = new Map<string, "lean" | "full" | "off">();
const pendingEngineNotificationBySession = new Map<string, string | null>();

export function formatEngineNotification(effectiveProfile: "lean" | "full" | "off"): string {
	if (effectiveProfile === "lean") {
		return `<system_notification>\nRetrieval engine updated: Lean Mode (lexical BM25 over code AST chunks).\nFormulate \`code_search\` queries using 3–5 mechanism keywords, domain nouns, or code identifier patterns likely to appear in source code or docstrings (e.g., "connection idle timeout", "token expiration").\n</system_notification>`;
	}
	if (effectiveProfile === "full") {
		return `<system_notification>\nRetrieval engine updated: Full Mode (hybrid BM25 + 768-dim ModernBERT neural embeddings via RRF).\nFormulate \`code_search\` queries using both technical keywords and conceptual intent phrases (e.g., "dropping dead upstream sockets", "session lifecycle").\n</system_notification>`;
	}
	return `<system_notification>\nRetrieval engine updated: Off profile (retrieval disabled).\n\`code_search\` is disabled and returns an error. Direct discovery to \`rg -n\` and file reading tools.\n</system_notification>`;
}

export function getPendingEngineNotification(sessionId: string): string | null {
	return pendingEngineNotificationBySession.get(sessionId) ?? null;
}

export function getLastNotifiedProfile(sessionId: string): ("lean" | "full" | "off") | undefined {
	return lastNotifiedProfileBySession.get(sessionId);
}

export function clearEngineNotificationState(): void {
	lastNotifiedProfileBySession.clear();
	pendingEngineNotificationBySession.clear();
}

function withoutPiDocumentation(systemPrompt: string): string {
	const taggedMatch = PI_DOCS_TAGGED.exec(systemPrompt);
	if (taggedMatch && taggedMatch.index !== undefined) {
		const start = taggedMatch.index;
		const end = start + taggedMatch[0].length;
		const before = systemPrompt.slice(0, start).replace(/\n{2,}$/, "\n");
		const after = systemPrompt.slice(end).replace(/^\n{2,}/, "\n");
		return before + after;
	}
	const startMatch = PI_DOCS_START.exec(systemPrompt);
	if (!startMatch || startMatch.index === undefined) return systemPrompt;
	const start = startMatch.index;
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

export function renderKernelGuidance(guidance: string, availableTools: ReadonlySet<string>): string {
	return KERNEL_TOOL_BLOCKS.reduce((rendered, block) => {
		const toolName = block.toLowerCase();
		// Tolerate CRLF: a git checkout with core.autocrlf produces CRLF line endings, and a
		// pattern requiring a bare LF never matches. That failure is silent: it disables gating
		// entirely, shipping the raw <!-- KERNEL:... --> comments and advertising tools that
		// are not registered.
		const pattern = new RegExp(`<!-- KERNEL:${block} -->\\r?\n([\\s\\S]*?)\\r?\n<!-- /KERNEL:${block} -->\\r?\n?`, "g");
		return rendered.replace(pattern, (_match, body: string) => availableTools.has(toolName) ? `${body}\n` : "");
	}, guidance);
}

function loadKernelGuidance(
	toolCollisions: ReadonlySet<string>,
	availableTools: ReadonlySet<string>,
): string {
	if (kernelGuidance === undefined) {
		try {
			const instructionPath = path.join(__dirname, "..", "AGENT_KERNEL_SYS_PROMPT.md");
			const contents = fs.readFileSync(instructionPath, "utf8").trim();
			kernelGuidance = contents || null;
		} catch (error) {
			kernelGuidance = null;
			kernelDebug(error);
		}
	}

	const base = kernelGuidance ?? "";
	const rendered = renderKernelGuidance(base, availableTools);
	if (toolCollisions.size === 0) return rendered;
	return [
		rendered,
		"",
		"## Tool Integration Notice",
		`Pi reports that another extension already owns: ${[...toolCollisions].sort((a, b) => a.localeCompare(b)).join(", ")}. Agent Kernel did not replace those tools. Kernel-specific output limits, read-before-write checks, or edit verification may not apply to them.`,
	].filter(Boolean).join("\n");
}

function appendKernelGuidance(systemPrompt: string, guidance: string): string {
	if (!guidance) return systemPrompt;
	const trimmed = guidance.trim();
	const wrapped = `${KERNEL_GUIDANCE_MARKER}\n${trimmed}\n</agent_kernel_guidance>`;
	if (systemPrompt.includes(wrapped) || systemPrompt.includes(guidance) || systemPrompt.includes(trimmed)) {
		return systemPrompt;
	}
	const base = systemPrompt.trimEnd();
	return `${base ? `${base}\n\n` : ""}${wrapped}`;
}
import { clampCommandOutput, getSpilloverRoot } from "./safety/output_clamper";
import { sanitizeSessionFiles } from "./context/session_repair";
import { formatSearchEngineTag, renderFooter } from "./ui/footer";
import { renderHostEnvironment } from "./safety/host_environment";

export default async function unifiedHybridExtension(pi: ExtensionAPI) {
	// Initialize TreeSitter WASM engine eagerly in background
	TreeSitterEngine.getInstance().init().catch((err) => {
		kernelDebug(`TreeSitter background init error: ${err}`);
	});

	// 3. Slash Commands: /agent-kernel, /pi-docs
	let activeTui: any = null;
	let projectTrusted = false;
	const configByWorkspace = new Map<
		string,
		ReturnType<typeof loadKernelConfig>
	>();
	const getConfig = (cwd: string) => {
		const workspace = path.resolve(cwd);
		const cacheKey = `${workspace}\0${projectTrusted}`;
		let config = configByWorkspace.get(cacheKey);
		if (!config) {
			config = loadKernelConfig(workspace, { projectTrusted });
			configByWorkspace.set(cacheKey, config);
		}
		return config;
	};
	const searchIndexes = new Map<string, HybridSearchIndex>();
	const getSearchIndex = (cwd: string) => {
		const workspace = path.resolve(cwd);
		let index = searchIndexes.get(workspace);
		if (!index) {
			const profile = getConfig(workspace).retrieval.default_profile;
			index = new HybridSearchIndex(workspace, profile, { projectTrusted });
			searchIndexes.set(workspace, index);
		}
		return index;
	};

	// Helper: Background index synchronization with statusline indicator
	const syncRetrievalStatus = (ctx: any, customText?: string) => {
		if (!ctx?.ui?.setStatus) return;
		const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
		const config = getConfig(cwd);
		if (!config.ui.enable_pastel_footer) {
			ctx.ui.setStatus("retrieval", "");
			activeTui?.requestRender?.();
			return;
		}

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

	let activeIndexingGeneration = 0;

	const triggerBackgroundIndexing = (
		index: HybridSearchIndex,
		ctx: any,
		isFullSync = false,
	) => {
		const currentGeneration = ++activeIndexingGeneration;
		const eff = index.getEffectiveProfile();
		if (eff === "off") {
			syncRetrievalStatus(ctx);
			return;
		}

		const streamArrow = "\x1b[38;2;155;210;170m⇢\x1b[0m";
		syncRetrievalStatus(
			ctx,
			`${formatSearchEngineTag(index, true)} ${streamArrow} \x1b[38;2;165;175;190m(indexing...)\x1b[0m`,
		);

		const runSync = async () => {
			return index.syncWorkspace(
				isFullSync,
				(msg: string) => {
					if (currentGeneration !== activeIndexingGeneration) return;
					const engineTag = formatSearchEngineTag(index, true);
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
				if (currentGeneration !== activeIndexingGeneration) return;
				if (index.getEffectiveProfile() === "off") {
					ctx?.ui?.setStatus?.("retrieval", "");
					activeTui?.requestRender?.();
					return;
				}
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
				if (currentGeneration !== activeIndexingGeneration) return;
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

	const applyConfigChanges = (cwd: string, ctx?: any) => {
		const workspace = path.resolve(cwd);
		configByWorkspace.delete(`${workspace}\0true`);
		configByWorkspace.delete(`${workspace}\0false`);
		const newConfig = getConfig(workspace);
		const newProfile = newConfig.retrieval.default_profile;

		// 1. Live update of running in-memory search index if profile changed
		const index = searchIndexes.get(workspace);
		if (index) {
			if (index.getProfile() !== newProfile) {
				index.setProfile(newProfile);
				if (ctx) {
					triggerBackgroundIndexing(index, ctx, false);
				}
			}
		}

		// 2. Track engine notification with intra-turn net-state collapsing (zero-stack)
		if (ctx && index) {
			const sessionId = getSessionId(ctx);
			const eff = index.getEffectiveProfile();
			const lastNotified = lastNotifiedProfileBySession.get(sessionId);
			if (eff !== lastNotified) {
				pendingEngineNotificationBySession.set(sessionId, formatEngineNotification(eff));
			} else {
				// User switched back and forth resulting in zero net change: cancel pending
				pendingEngineNotificationBySession.delete(sessionId);
			}
		}

		// 3. Refresh statusline and footer immediately
		if (ctx) {
			syncRetrievalStatus(ctx);
			activeTui?.requestRender?.();
		}
	};

	registerAgentKernelCommand(pi, {
		getConfig,
		invalidateConfig: (cwd, ctx) => {
			applyConfigChanges(cwd, ctx);
		},
		getSearchIndex: (cwd) => getSearchIndex(cwd),
		triggerBackgroundIndexing: (idx, ctx, isFull) => triggerBackgroundIndexing(idx, ctx, isFull),
	});

	pi.registerCommand("repair-sessions", {
		description: "Preview or explicitly apply repairs for malformed historical session usage metadata",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "", label: "preview - report repair candidates without writing" },
				{ value: "--apply", label: "--apply - back up and repair eligible inactive sessions" },
			];
			return options.filter((option) => option.value.startsWith(prefix.toLowerCase()));
		},
		handler: async (args: string, ctx: any) => {
			const mode = (args || "").trim().toLowerCase();
			if (mode && mode !== "--apply") {
				ctx.ui?.notify?.("Usage: /repair-sessions [--apply]", "error");
				return;
			}
			const activeSession = ctx?.sessionManager?.getSessionFile?.();
			const stats = sanitizeSessionFiles({
				skipFile: activeSession,
				apply: mode === "--apply",
			});
			const summary = stats.dryRun
				? `Session repair preview: ${stats.candidateFiles} candidate file(s), ${stats.repairedEntries} entr(ies); no files written.`
				: `Session repair complete: ${stats.repairedFiles} repaired, ${stats.skippedFiles} skipped, ${stats.failedFiles} failed.`;
			ctx.ui?.notify?.(summary, stats.failedFiles > 0 ? "error" : "info");
			console.log(`[repair-sessions] ${summary} ${JSON.stringify(stats)}`);
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

	// Background workspace auto-indexer on session startup + setup integrated footer
	pi.on("session_start", async (_event: any, ctx: any) => {
		projectTrusted = ctx.isProjectTrusted?.() === true;
		configByWorkspace.clear();
		const sessionId = getSessionId(ctx);
		const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
		registerKernelTools();
		setupUnifiedFooter(ctx);
		try {
			const index = getSearchIndex(cwd);
			lastNotifiedProfileBySession.set(sessionId, index.getEffectiveProfile());
			pendingEngineNotificationBySession.delete(sessionId);
			if (index.getEffectiveProfile() !== "off") {
				triggerBackgroundIndexing(index, ctx, false);
			}
		} catch (e) {
			kernelDebug(e);
		}
	});

	// 2. Per-session cleanup of the epistemic guard's inspection state.
	// Without this, Map<sessionId, Set<filePath>> grows unbounded over a
	// long-lived process hosting many sessions (e.g. RPC mode). On session
	// shutdown we drop only this session's entry.
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		const sessionId = getSessionId(ctx);
		piDocsEnabledBySession.delete(sessionId);
		lastNotifiedProfileBySession.delete(sessionId);
		pendingEngineNotificationBySession.delete(sessionId);
		globalEpistemicGuard.resetSession(sessionId);
		// Flush any debounced search index writes to disk on shutdown and halt further admissions
		for (const index of searchIndexes.values()) {
			try {
				await index.flushPendingSave(true);
			} catch (e) {
				kernelDebug(e);
			}
		}
	});

	// Tools are registered at session start, after every extension factory has
	// registered its tools. This makes collision handling independent of package
	// load order and lets project trust affect optional-tool registration.
	const toolCollisions = new Set<string>();
	const kernelRegisteredTools = new Set<string>();
	let kernelToolsRegistered = false;
	const invalidateSearchFile = async (cwd: string, filePath: string) => {
		const index = getSearchIndex(cwd);
		await index.updateFile(filePath).catch((err) => {
			kernelDebug(`Incremental updateFile error for ${filePath}: ${err}`);
		});
	};
	const registerKernelTools = (): void => {
		if (kernelToolsRegistered) return;
		kernelToolsRegistered = true;
		// pi marks its own built-in tools with sourceInfo.source === "builtin" and a
		// "builtin:<name>" path (BUILTIN_PATH_PREFIX in pi's core/source-info). Only tools owned
		// by another extension are collisions: extension tools override built-ins in pi's tool
		// registry, so built-ins must be excluded here or we would never register our own read/edit.
		const extensionTools = (pi.getAllTools?.() || []).filter(
			(tool: any) =>
				tool?.sourceInfo?.source !== "builtin" &&
				!String(tool?.sourceInfo?.path || "").startsWith("builtin:"),
		);
		const owned = new Set(extensionTools.map((tool: any) => tool.name));
		if (owned.has("bash")) toolCollisions.add("bash");
		const canRegister = (name: string): boolean => {
			if (owned.has(name)) {
				toolCollisions.add(name);
				return false;
			}
			return true;
		};

		if (canRegister("read")) {
			registerReadTool(pi, { getSessionId, getConfig });
			kernelRegisteredTools.add("read");
		}
		if (canRegister("edit")) {
			registerEditTool(pi, { getSessionId, getConfig, invalidateSearchFile });
			kernelRegisteredTools.add("edit");
		}
		// Register independently of the first session's profile: one extension instance may
		// serve multiple workspaces. Availability is gated per workspace in execution and prompts.
		if (canRegister("code_search")) {
			registerCodeSearchTool(pi, { getSessionId, getSearchIndex, getConfig });
			kernelRegisteredTools.add("code_search");
		}
	};

	// 9a. Block host writes before the host tool can create parent directories
	// or overwrite the target. Bash read evidence is recorded after a successful
	// command result below; preflight classification alone is not a read.
	pi.on("tool_call", async (event: any, ctx: any) => {
		try {
			const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
			const sessionId = getSessionId(ctx);
			if (event.toolName !== "write") return;
			const targetPath = (event.input as Record<string, unknown> | undefined)?.path;
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
		// Kernel tools return their failures, and pi drops a returned isError; markReturnedErrors kept it in details.
		if (!event.isError && kernelRegisteredTools.has(event.toolName) && event.details?.isError === true) {
			return { isError: true };
		}
		const isShell = event.toolName === "bash" || event.toolName === "powershell";
		if (event.isError && !isShell) return;

		// resultContent === undefined means "no transformation, return event.content as-is".
		const toolName = event.toolName;
		let resultContent: any = undefined;
		let didBail = false;

		// 9a. Intercept bash & powershell output to clamp minified lines & massive match floods
		if (toolName === "bash" || toolName === "powershell") {
			const command = String((event.input as Record<string, unknown> | undefined)?.command || "");
			const outputConfig = getConfig(
				ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd(),
			);
			let bashOutputComplete = true;
			resultContent = (event.content || []).map((c: any) => {
				if (c.type === "text" && typeof c.text === "string") {
						const spilloverDir = getSpilloverRoot(
							ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd(),
						);
						const clamped = clampCommandOutput(c.text, command, {
							maxLineLength: outputConfig.safety.max_line_length,
							maxLines: outputConfig.safety.max_lines,
							maxTotalBytes: outputConfig.safety.max_total_bytes,
							spilloverDir,
							isError: event.isError,
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
					.flatMap((c: any) => (c?.type === "text" && typeof c?.text === "string" ? [c.text] : []))
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
		// here would duplicate syntax verification work.
		if (toolName === "write") {
			const input = event.input as Record<string, unknown> | undefined;
			const targetPath = typeof input?.path === "string" ? input.path : undefined;

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

				await TreeSitterEngine.getInstance().loadLanguages([path.extname(resolvedPath).toLowerCase()]);
				const syntaxRes = checkSyntax(resolvedPath);

				if (!syntaxRes.valid && syntaxRes.status === "failed") {
					const warning = `\n\n[SYNTAX WARNING] ${syntaxRes.error}\nPlease fix this syntax error.`;
					resultContent = event.content.map((c: any) =>
						c.type === "text" ? { ...c, text: c.text + warning } : c,
					);
				}
			}
		}

		if (didBail) return;
		if (resultContent !== undefined) {
			return { content: resultContent };
		}
	});

	// 10. Dynamic Runtime Context Injection (optional repository map only)
	// Custom user instructions remain the primary authority. Repository-controlled
	// diffs, source text, filenames, and command output are never promoted into the
	// system prompt by this extension.
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const currentCwd = ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd();
		const sessionId = getSessionId(ctx);
		const kernelConfig = getConfig(currentCwd);

		const basePrompt = event.systemPrompt || "";
		const includePiDocs = piDocsEnabled(ctx);
		if (!includePiDocs && event.systemPromptOptions?.sections?.docs !== undefined) {
			delete event.systemPromptOptions.sections.docs;
		}
		const systemPrompt = includePiDocs
			? basePrompt
			: withoutPiDocumentation(basePrompt);
		const activeToolNames = new Set(pi.getActiveTools?.() || []);
		const promptToolNames = new Set<string>();
		for (const name of ["read", "edit", "code_search", "bash"]) {
			const enabledForWorkspace = name !== "code_search" || kernelConfig.retrieval.default_profile !== "off";
			if (enabledForWorkspace && activeToolNames.has(name) && !toolCollisions.has(name) && (name === "bash" || kernelRegisteredTools.has(name))) {
				promptToolNames.add(name);
			}
		}
		const guidance = kernelConfig.instructions.enabled
			? loadKernelGuidance(toolCollisions, promptToolNames)
			: "";
		const hostEnv = kernelConfig.instructions.enabled && kernelConfig.instructions.host_environment !== false
			? renderHostEnvironment()
			: "";

		let guidedPrompt = appendKernelGuidance(systemPrompt, guidance);
		if (hostEnv && !guidedPrompt.includes("<host_environment>")) {
			if (guidedPrompt.includes(KERNEL_GUIDANCE_MARKER)) {
				guidedPrompt = guidedPrompt.replace(KERNEL_GUIDANCE_MARKER, `${hostEnv}\n\n${KERNEL_GUIDANCE_MARKER}`);
			} else {
				guidedPrompt = `${guidedPrompt.trimEnd()}\n\n${hostEnv}`;
			}
		}

		const pendingNotification = pendingEngineNotificationBySession.get(sessionId);
		if (pendingNotification) {
			pendingEngineNotificationBySession.delete(sessionId);
			try {
				const index = getSearchIndex(currentCwd);
				lastNotifiedProfileBySession.set(sessionId, index.getEffectiveProfile());
			} catch {}
			return {
				systemPrompt: guidedPrompt,
				message: {
					customType: "agent-kernel-engine-notification",
					content: pendingNotification,
					display: true,
				},
			};
		}

		return { systemPrompt: guidedPrompt };
	});
}
