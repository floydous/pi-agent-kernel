import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	saveGlobalKernelConfig,
	getGlobalConfigPath,
	getProjectConfigPath,
	type KernelConfig,
	type KernelConfigOverrides,
} from "./kernel_config";
import { UnifiedControlModal } from "../retrieval/search_modal";

export interface AgentKernelCommandDeps {
	getConfig: (cwd: string) => KernelConfig;
	invalidateConfig: (cwd: string, ctx?: any) => void;
	clearCaches?: () => void;
	getSearchIndex?: (cwd: string) => any;
	triggerBackgroundIndexing?: (index: any, ctx: any, isFullSync?: boolean) => void;
}

export function formatConfigDashboard(cwd: string, config: KernelConfig): string {
	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);
	const globalExists = fs.existsSync(globalPath);
	const projectExists = projectPath ? fs.existsSync(projectPath) : false;

	const lines = [
		`=== Pi Agent Kernel Configuration ===`,
		`Global Config : ${globalPath} [${globalExists ? "FOUND" : "DEFAULT"}]`,
		`Project Config: ${projectPath ?? "none"} [${projectExists ? "ACTIVE" : "NONE"}]`,
		``,
		`[Retrieval & Tools]`,
		`  • Profile (Engine)      : ${config.retrieval.default_profile} (auto | lean | full | off)`,
		`  • Max Search Results    : ${config.retrieval.max_search_results}`,
		``,
		`[Safety & Interception]`,
		`  • Epistemic Guard       : ${config.safety.enable_epistemic_guard ? "ENABLED (read-before-write)" : "DISABLED"}`,
		`  • Output Clamping Lines : ${config.safety.max_lines} lines (head+tail)`,
		`  • Output Clamping Bytes : ${Math.round(config.safety.max_total_bytes / 1024)} KB ceiling`,
		`  • Max Line Width        : ${config.safety.max_line_length} chars`,
		``,
		`[Editing & Anchors]`,
		`  • Engine Mode           : ${config.editing.mode} (smart_anchor | standard)`,
		`  • Read Mode             : ${config.editing.read_mode} (plain | anchored | auto)`,
		`  • Default Anchors       : ${config.editing.default_anchors ? "true" : "false"}`,
		`  • Fullwidth Dot Normalization : ${config.editing.normalize_fullwidth_dots !== false ? "ENABLED" : "DISABLED"}`,
		``,
		`[System & UI]`,
		`  • Kernel Guidance Prompt: ${config.instructions.enabled ? "ENABLED" : "DISABLED"}`,
		`  • Host Environment Info : ${config.instructions.host_environment !== false ? "ENABLED" : "DISABLED"}`,
		`  • Pi Docs System Guidance : ${config.instructions.pi_docs ? "ENABLED" : "DISABLED"}`,
		`  • Pastel Status Footer  : ${config.ui.enable_pastel_footer ? "ENABLED" : "DISABLED"}`,
		``,
		`Interactive UI: run '/agent-kernel' in TUI mode`,
		`Modify setting: run '/agent-kernel set <key> <value>'`,
		`Reset to defaults: run '/agent-kernel reset'`,
	];

	return lines.join("\n");
}

export function registerAgentKernelCommand(pi: ExtensionAPI, deps: AgentKernelCommandDeps): void {
	pi.registerCommand("agent-kernel", {
		description: "Configure all Pi Agent Kernel global settings interactively or via CLI",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				{ value: "status", label: "status - Display full configuration status" },
				{ value: "set", label: "set <key> <val> - Update a setting globally" },
				{ value: "reset", label: "reset - Reset global configuration to defaults" },
				{ value: "engine", label: "engine - Open retrieval engine control tab" },
				{ value: "scope", label: "scope - Open file index scope selector tab" },
				{ value: "reindex", label: "reindex - Force full workspace re-indexing" },
			];

			const keys = [
				{ value: "set profile", label: "set profile <auto|lean|full|off> - Retrieval engine profile" },
				{ value: "set epistemic", label: "set epistemic <on|off> - Toggle Epistemic Guard" },
				{ value: "set editing", label: "set editing <smart_anchor|standard> - Editing engine mode" },
				{ value: "set read_mode", label: "set read_mode <plain|anchored|auto> - Reading anchor mode" },
				{ value: "set guidance", label: "set guidance <on|off> - Toggle kernel system prompt guidance" },
				{ value: "set host_environment", label: "set host_environment <on|off> - Toggle host environment info in system prompt" },
				{ value: "set pi_docs", label: "set pi_docs <on|off> - Toggle Pi documentation guide in system prompt" },
				{ value: "set footer", label: "set footer <on|off> - Toggle pastel status footer" },
				{ value: "set max_lines", label: "set max_lines <40|100|200> - Output clamping line ceiling" },
			];

			const allOptions = [...subcommands, ...keys];
			const filtered = allOptions.filter((o) => o.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const raw = (args || "").trim();
			const currentCwd = ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd();
			const config = deps.getConfig(currentCwd);

			// 1. Handle CLI commands (status, set, reset)
			if (raw.startsWith("status")) {
				const statusText = formatConfigDashboard(currentCwd, config);
				if (ctx.hasUI && ctx.ui?.notify) {
					ctx.ui.notify("Displayed Agent Kernel configuration.", "info");
				}
				console.log("\n" + statusText + "\n");
				return;
			}

			if (raw === "reindex") {
				const index = deps.getSearchIndex ? deps.getSearchIndex(currentCwd) : undefined;
				if (index) {
					ctx.ui?.notify?.("Re-indexing workspace...", "info");
					deps.triggerBackgroundIndexing?.(index, ctx, true);
					return;
				}
			}
			if (raw.startsWith("reset")) {
				const globalPath = getGlobalConfigPath();
				try {
					if (fs.existsSync(globalPath)) {
						fs.unlinkSync(globalPath);
					}
					const legacySettings = path.join(path.dirname(globalPath), "search_settings.json");
					if (fs.existsSync(legacySettings)) {
						try { fs.unlinkSync(legacySettings); } catch {}
					}
					deps.invalidateConfig(currentCwd, ctx);
					deps.clearCaches?.();
					const msg = "Reset global Agent Kernel configuration to defaults.";
					ctx.ui?.notify?.(msg, "info");
					console.log(msg);
				} catch (e: any) {
					ctx.ui?.notify?.(`Failed to reset: ${e.message}`, "error");
				}
				return;
			}

			if (raw.startsWith("set ")) {
				const parts = raw.slice(4).trim().split(/\s+/);
				const key = (parts[0] || "").toLowerCase();
				const val = (parts[1] || "").toLowerCase();

				const updates: KernelConfigOverrides = {};
				let desc = "";

				switch (key) {
					case "profile":
					case "engine": {
						if (val === "auto" || val === "lean" || val === "hybrid" || val === "full" || val === "off") {
							updates.retrieval = { default_profile: val };
							desc = `Retrieval profile set to '${val}'`;
						} else {
							ctx.ui?.notify?.("Invalid profile. Options: auto | lean | hybrid | full | off", "error");
							return;
						}
						break;
					}
					case "epistemic":
					case "epistemic_guard": {
						const enable = val === "on" || val === "true" || val === "1" || val === "enabled";
						updates.safety = { enable_epistemic_guard: enable };
						desc = `Epistemic Guard set to ${enable ? "ENABLED" : "DISABLED"}`;
						break;
					}
					case "editing":
					case "editing_mode": {
						if (val === "smart_anchor" || val === "standard") {
							updates.editing = { mode: val };
							desc = `Editing mode set to '${val}'`;
						} else {
							ctx.ui?.notify?.("Invalid editing mode. Options: smart_anchor | standard", "error");
							return;
						}
						break;
					}
					case "read_mode": {
						if (val === "plain" || val === "anchored" || val === "auto") {
							updates.editing = { read_mode: val };
							desc = `Read mode set to '${val}'`;
						} else {
							ctx.ui?.notify?.("Invalid read mode. Options: plain | anchored | auto", "error");
							return;
						}
						break;
					}
					case "fullwidth_dots":
					case "normalize_fullwidth_dots":
					case "normalize_dots": {
						const enable = val === "on" || val === "true" || val === "1" || val === "enabled";
						updates.editing = { normalize_fullwidth_dots: enable };
						desc = `Fullwidth dot normalization set to ${enable ? "ENABLED" : "DISABLED"}`;
						break;
					}
					case "guidance":
					case "instructions": {
						const enable = val === "on" || val === "true" || val === "1" || val === "enabled";
						updates.instructions = { enabled: enable };
						desc = `Kernel guidance prompt set to ${enable ? "ENABLED" : "DISABLED"}`;
						break;
					}
					case "host_environment":
					case "host-environment":
					case "host_env":
					case "host-env": {
						const enable = val === "on" || val === "true" || val === "1" || val === "enabled";
						updates.instructions = { host_environment: enable };
						desc = `Host environment prompt set to ${enable ? "ENABLED" : "DISABLED"}`;
						break;
					}
					case "pi_docs":
					case "pi-docs":
					case "docs": {
						const enable = val === "on" || val === "true" || val === "1" || val === "enabled";
						updates.instructions = { pi_docs: enable };
						desc = `Pi documentation guidance set to ${enable ? "ENABLED" : "DISABLED"}`;
						break;
					}
					case "footer":
					case "pastel_footer": {
						const enable = val === "on" || val === "true" || val === "1" || val === "enabled";
						updates.ui = { enable_pastel_footer: enable };
						desc = `Pastel status footer set to ${enable ? "ENABLED" : "DISABLED"}`;
						break;
					}
					case "max_lines": {
						const num = parseInt(val, 10);
						if (Number.isSafeInteger(num) && num >= 10 && num <= 1000) {
							updates.safety = { max_lines: num };
							desc = `Output clamping lines set to ${num}`;
						} else {
							ctx.ui?.notify?.("Invalid line limit (must be 10-1000)", "error");
							return;
						}
						break;
					}
					default:
						ctx.ui?.notify?.(`Unknown setting key: '${key}'. Run '/agent-kernel' for options.`, "error");
						return;
				}

				saveGlobalKernelConfig(updates);
				deps.invalidateConfig(currentCwd, ctx);
				deps.clearCaches?.();
				ctx.ui?.notify?.(`Saved to ~/.pi/agent/config.toml: ${desc}`, "info");
				console.log(`[agent-kernel] ${desc} (persisted globally)`);
				return;
			}

			// 2. Interactive TUI Settings Screen (3-Tab Unified Controller)
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const statusText = formatConfigDashboard(currentCwd, config);
				console.log("\n" + statusText + "\n");
				return;
			}

			let initialTab: 0 | 1 | 2 = 0;
			if (raw === "engine" || raw.startsWith("engine")) {
				initialTab = 1;
			} else if (raw === "scope" || raw.startsWith("scope")) {
				initialTab = 2;
			}

			const index = deps.getSearchIndex ? deps.getSearchIndex(currentCwd) : undefined;
			await ctx.ui.custom((tui: any, theme: any, kb: any, done: (res?: any) => void) => {
				return new UnifiedControlModal(
					tui,
					index,
					theme,
					(res) => {
						if (res) {
							if (res.action === "reindex" || res.excludedPathsChanged) {
								deps.triggerBackgroundIndexing?.(index, ctx, res.action === "reindex");
							}
						}
						done(res);
					},
					{
						initialTab,
						cwd: currentCwd,
						deps,
						ctx,
						keybindings: kb,
					},
				);
			});
		},
	});
}
