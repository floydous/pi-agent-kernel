import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	loadKernelConfig,
	saveGlobalKernelConfig,
	removeGlobalKernelConfigKey,
	saveProjectKernelConfig,
	getGlobalConfigPath,
	getGlobalRawConfig,
	getProjectConfigPath,
	type KernelConfig,
	type KernelConfigOverrides,
	type CodebaseProfile,
} from "./kernel_config";

export interface AgentKernelCommandDeps {
	getConfig: (cwd: string) => KernelConfig;
	invalidateConfig: (cwd: string, ctx?: any) => void;
	clearCaches?: () => void;
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
		`  • Profile (Engine)      : ${config.retrieval.default_profile} (lean | hybrid | full)`,
		`  • Codebase Scale        : ${config.retrieval.codebase_profile} (auto | light | heavy)`,
		`  • Passive Shield        : ${config.retrieval.enable_tools ? "all (6 tools exposed)" : "gated (core 3 tools default)"}`,
		`  • Repo Map Budget       : ${config.retrieval.repo_map_budget} tokens`,
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
		``,
		`[System & UI]`,
		`  • Kernel Guidance Prompt: ${config.instructions.enabled ? "ENABLED" : "DISABLED"}`,
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
			];

			const keys = [
				{ value: "set tools", label: "set tools <gated|all> - Toggle Passive Shield tool gating" },
				{ value: "set profile", label: "set profile <lean|hybrid|full> - Retrieval engine profile" },
				{ value: "set codebase", label: "set codebase <auto|light|heavy> - Codebase scale profile" },
				{ value: "set epistemic", label: "set epistemic <on|off> - Toggle Epistemic Guard" },
				{ value: "set editing", label: "set editing <smart_anchor|standard> - Editing engine mode" },
				{ value: "set read_mode", label: "set read_mode <plain|anchored|auto> - Reading anchor mode" },
				{ value: "set guidance", label: "set guidance <on|off> - Toggle kernel system prompt guidance" },
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
					case "tools":
					case "passive_shield": {
						const enable = val === "all" || val === "true" || val === "1";
						updates.retrieval = { enable_tools: enable };
						desc = `Passive Shield tools set to '${enable ? "all (6 tools)" : "gated (core 3 tools)"}' (takes effect on reload)`;
						break;
					}
					case "profile":
					case "engine": {
						if (val === "lean" || val === "hybrid" || val === "full") {
							updates.retrieval = { default_profile: val };
							desc = `Retrieval profile set to '${val}'`;
						} else {
							ctx.ui?.notify?.("Invalid profile. Options: lean | hybrid | full", "error");
							return;
						}
						break;
					}
					case "codebase":
					case "codebase_profile": {
						if (val === "auto" || val === "light" || val === "heavy") {
							updates.retrieval = { codebase_profile: val };
							desc = `Codebase scale profile set to '${val}'`;
						} else {
							ctx.ui?.notify?.("Invalid codebase profile. Options: auto | light | heavy", "error");
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
					case "guidance":
					case "instructions": {
						const enable = val === "on" || val === "true" || val === "1" || val === "enabled";
						updates.instructions = { enabled: enable };
						desc = `Kernel guidance prompt set to ${enable ? "ENABLED" : "DISABLED"}`;
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
						if (!isNaN(num) && num >= 10 && num <= 1000) {
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

			// 2. Interactive TUI Settings Screen
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const statusText = formatConfigDashboard(currentCwd, config);
				console.log("\n" + statusText + "\n");
				return;
			}

			// TUI Interactive Modal with categorized layout and built-in search
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (res?: any) => void) => {
				const currentConfig = deps.getConfig(currentCwd);

				interface CategorizedSettingItem {
					category: string;
					id: string;
					label: string;
					currentValue: string;
					values: string[];
					descriptions: Record<string, string>;
					isGlobal: boolean;
				}

				const CATEGORY_ORDER = [
					"Retrieval & Exploration",
					"Safety & Verification",
					"Editing Engine",
					"System Guidance & UI",
				];

				const globalRaw = getGlobalRawConfig();
				function checkIsGlobal(id: string): boolean {
					if (id === "tools") return globalRaw.retrieval?.enable_tools !== undefined;
					if (id === "profile") return globalRaw.retrieval?.default_profile !== undefined;
					if (id === "codebase") return globalRaw.retrieval?.codebase_profile !== undefined;
					if (id === "epistemic") return globalRaw.safety?.enable_epistemic_guard !== undefined;
					if (id === "max_lines") return globalRaw.safety?.max_lines !== undefined;
					if (id === "editing") return globalRaw.editing?.mode !== undefined;
					if (id === "read_mode") return globalRaw.editing?.read_mode !== undefined;
					if (id === "guidance") return globalRaw.instructions?.enabled !== undefined;
					if (id === "pi_docs") return globalRaw.instructions?.pi_docs !== undefined;
					if (id === "footer") return globalRaw.ui?.enable_pastel_footer !== undefined;
					return false;
				}

				function createPatchForSetting(id: string, value: string): { patch: KernelConfigOverrides; desc: string } {
					const patch: KernelConfigOverrides = {};
					let desc = "";
					if (id === "tools") {
						const enable = value.startsWith("all");
						patch.retrieval = { enable_tools: enable };
						desc = `Passive Shield tools = ${enable ? "all (6 tools)" : "gated (core 3)"}`;
					} else if (id === "profile") {
						patch.retrieval = { default_profile: value as any };
						desc = `Retrieval profile = ${value}`;
					} else if (id === "codebase") {
						patch.retrieval = { codebase_profile: value as any };
						desc = `Codebase scale profile = ${value}`;
					} else if (id === "epistemic") {
						const enable = value === "enabled";
						patch.safety = { enable_epistemic_guard: enable };
						desc = `Epistemic Guard = ${enable ? "enabled" : "disabled"}`;
					} else if (id === "editing") {
						patch.editing = { mode: value as any };
						desc = `Editing mode = ${value}`;
					} else if (id === "read_mode") {
						patch.editing = { read_mode: value as any };
						desc = `Reading anchor protocol = ${value}`;
					} else if (id === "guidance") {
						const enable = value === "enabled";
						patch.instructions = { enabled: enable };
						desc = `Kernel guidance prompt = ${enable ? "enabled" : "disabled"}`;
					} else if (id === "pi_docs") {
						const enable = value === "enabled";
						patch.instructions = { pi_docs: enable };
						desc = `Pi documentation guidance = ${enable ? "enabled" : "disabled"}`;
					} else if (id === "footer") {
						const enable = value === "enabled";
						patch.ui = { enable_pastel_footer: enable };
						desc = `Pastel status footer = ${enable ? "enabled" : "disabled"}`;
					} else if (id === "max_lines") {
						const num = parseInt(value, 10);
						if (!isNaN(num)) {
							patch.safety = { max_lines: num };
							desc = `Output clamping = ${num} lines`;
						}
					}
					return { patch, desc };
				}

				function getSettingSectionAndKey(id: string): { section: string; key: string } | null {
					switch (id) {
						case "tools":
							return { section: "retrieval", key: "enable_tools" };
						case "profile":
							return { section: "retrieval", key: "default_profile" };
						case "codebase":
							return { section: "retrieval", key: "codebase_profile" };
						case "epistemic":
							return { section: "safety", key: "enable_epistemic_guard" };
						case "max_lines":
							return { section: "safety", key: "max_lines" };
						case "editing":
							return { section: "editing", key: "mode" };
						case "read_mode":
							return { section: "editing", key: "read_mode" };
						case "guidance":
							return { section: "instructions", key: "enabled" };
						case "pi_docs":
							return { section: "instructions", key: "pi_docs" };
						case "footer":
							return { section: "ui", key: "enable_pastel_footer" };
						default:
							return null;
					}
				}

				const items: CategorizedSettingItem[] = [
					// 1. Retrieval & Exploration
					{
						category: "Retrieval & Exploration",
						id: "tools",
						label: "Passive Shield (Tool Gating)",
						currentValue: currentConfig.retrieval.enable_tools ? "all (6 tools)" : "gated (core 3)",
						values: ["gated (core 3)", "all (6 tools)"],
						isGlobal: checkIsGlobal("tools"),
						descriptions: {
							"gated (core 3)":
								"Passive Shield active: Only core tools (read, edit, code_search) are exposed. Gates exploratory tools to save ~3,400 prompt tokens per turn.",
							"all (6 tools)":
								"Passive Shield disabled: All 6 tools (including ast_search, get_repo_map, lsp) are exposed simultaneously. Higher token overhead.",
						},
					},
					{
						category: "Retrieval & Exploration",
						id: "profile",
						label: "Retrieval Engine Profile",
						currentValue: currentConfig.retrieval.default_profile,
						values: ["lean", "hybrid", "full"],
						isGlobal: checkIsGlobal("profile"),
						descriptions: {
							lean: "Lean profile: BM25 keyword index + AST code chunking. Zero RAM overhead, sub-millisecond retrieval, ideal for VPS and standard tasks.",
							hybrid:
								"Hybrid profile: BM25 keyword matching blended with Matryoshka sub-vector embeddings for balanced lexical and semantic retrieval.",
							full: "Full profile: Dense 768-dim embeddings with deep semantic chunking. Maximizes recall on complex multi-repository conceptual queries.",
						},
					},
					{
						category: "Retrieval & Exploration",
						id: "codebase",
						label: "Codebase Scale Profile",
						currentValue: currentConfig.retrieval.codebase_profile,
						values: ["auto", "light", "heavy"],
						isGlobal: checkIsGlobal("codebase"),
						descriptions: {
							auto: "Auto scale mode: Automatically analyzes repository file count and git metrics to dynamically size AST repo-mapping token budget.",
							light:
								"Light scale mode: Enforces minimal indexing and suppresses automatic repo-map injection for small repos and resource-tight environments.",
							heavy:
								"Heavy scale mode: Always injects full PageRank AST repository map for large multi-package enterprise codebases.",
						},
					},

					// 2. Safety & Verification
					{
						category: "Safety & Verification",
						id: "epistemic",
						label: "Epistemic Guard (Read-before-write)",
						currentValue: currentConfig.safety.enable_epistemic_guard ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
						isGlobal: checkIsGlobal("epistemic"),
						descriptions: {
							enabled:
								"Epistemic Guard active: Enforces strict read-before-write validation, preventing hallucinated edits, missing imports, and blind patch failures.",
							disabled:
								"Epistemic Guard inactive: Allows unconstrained edits without prior read operations. May lead to blind mutations or syntax breakages.",
						},
					},
					{
						category: "Safety & Verification",
						id: "max_lines",
						label: "Output Clamping Line Limit",
						currentValue: `${currentConfig.safety.max_lines} lines`,
						values: ["40 lines", "100 lines", "200 lines"],
						isGlobal: checkIsGlobal("max_lines"),
						descriptions: {
							"40 lines":
								"40 lines: Conservative head/tail output clamping with 0o600 /tmp spillover logging. Maximizes token conservation on long test/build runs.",
							"100 lines":
								"100 lines: Balanced output ceiling. Displays up to 50 head and 50 tail lines before generating secure disk spillover logs.",
							"200 lines":
								"200 lines: Extended output ceiling for large compilation logs and verbose test runner summaries.",
						},
					},

					// 3. Editing Engine
					{
						category: "Editing Engine",
						id: "editing",
						label: "Editing Mode (Smart Anchors)",
						currentValue: currentConfig.editing.mode === "smart_anchor" ? "smart_anchor" : "standard",
						values: ["smart_anchor", "standard"],
						isGlobal: checkIsGlobal("editing"),
						descriptions: {
							smart_anchor:
								"Smart Anchors: Deterministic Tree-sitter WASM validation (<2ms), lexical delimiter balancing, and line-hint disambiguation.",
							standard:
								"Standard editing: Standard exact string replacement without delimiter auto-healing or Tree-sitter syntax verification.",
						},
					},
					{
						category: "Editing Engine",
						id: "read_mode",
						label: "Reading Anchor Protocol",
						currentValue: currentConfig.editing.read_mode,
						values: ["plain", "anchored", "auto"],
						isGlobal: checkIsGlobal("read_mode"),
						descriptions: {
							plain:
								"Plain text reads: Clean, unanchored reading protocol. Reduces token consumption by ~84% compared to rigid line-hash anchor systems.",
							anchored:
								"Anchored reads: Injects LINE#HASH prefixes on every line for strict positional pinning. Increases context token consumption.",
							auto: "Adaptive reading: Defaults to clean plain text, automatically falling back to anchored reads when resolving ambiguous edit targets.",
						},
					},

					// 4. System Guidance & UI
					{
						category: "System Guidance & UI",
						id: "guidance",
						label: "Agent Guidance Prompt",
						currentValue: currentConfig.instructions.enabled ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
						isGlobal: checkIsGlobal("guidance"),
						descriptions: {
							enabled:
								"Kernel guidance active: Injects empirical tool discipline, grounding rules, and search strategies into the model system prompt.",
							disabled:
								"Kernel guidance inactive: Omits kernel prompt injection, running the agent with default model system prompt instructions.",
						},
					},
					{
						category: "System Guidance & UI",
						id: "pi_docs",
						label: "Pi Docs System Guidance (pi-docs)",
						currentValue: currentConfig.instructions.pi_docs ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
						isGlobal: checkIsGlobal("pi_docs"),
						descriptions: {
							enabled:
								"Pi docs included: Injects the complete Pi documentation guidance block into system prompt for Pi extensions, tools, and theme authoring.",
							disabled:
								"Pi docs omitted: Strips the ~1,200 token Pi documentation block to optimize prompt cache hit rate and token consumption.",
						},
					},
					{
						category: "System Guidance & UI",
						id: "footer",
						label: "Pastel Status Footer",
						currentValue: currentConfig.ui.enable_pastel_footer ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
						isGlobal: checkIsGlobal("footer"),
						descriptions: {
							enabled:
								"Pastel footer active: Displays terminal statusline at bottom showing active model, search index state, and memory metrics.",
							disabled:
								"Pastel footer inactive: Disables the bottom statusline widget for an uncluttered minimal terminal workspace.",
						},
					},
				];

				class DynamicBorder {
					color: (s: string) => string;
					constructor(color?: (s: string) => string) {
						this.color = color || ((s) => s);
					}
					invalidate() {}
					render(width: number): string[] {
						return [this.color("─".repeat(Math.max(1, width)))];
					}
				}

				class CategorizedSettingsList {
					items: CategorizedSettingItem[];
					filteredItems: CategorizedSettingItem[];
					theme: any;
					selectedIndex = 0;
					onCancel: () => void;
					searchInput: Input;
					categoryOrder: string[];

					constructor(
						items: CategorizedSettingItem[],
						theme: any,
						onCancel: () => void,
						categoryOrder: string[],
					) {
						this.items = items;
						this.filteredItems = items;
						this.theme = theme;
						this.onCancel = onCancel;
						this.categoryOrder = categoryOrder;
						this.searchInput = new Input();
					}

					applyFilter(query: string) {
						if (query) {
							const matches = fuzzyFilter(
								this.items,
								query,
								(item: CategorizedSettingItem) => {
									const descAll = item.descriptions ? Object.values(item.descriptions).join(" ") : "";
									return `${item.category} ${item.label} ${descAll} ${item.id}`;
								},
							);
							const catGroups = new Map<string, CategorizedSettingItem[]>();
							for (const item of matches) {
								const list = catGroups.get(item.category) || [];
								list.push(item);
								catGroups.set(item.category, list);
							}
							const result: CategorizedSettingItem[] = [];
							for (const cat of this.categoryOrder) {
								const list = catGroups.get(cat);
								if (list) result.push(...list);
							}
							this.filteredItems = result;
						} else {
							this.filteredItems = this.items;
						}
						this.selectedIndex = 0;
					}

					activateItem() {
						const item = this.filteredItems[this.selectedIndex];
						if (!item || !item.values || item.values.length === 0) return;
						const curIdx = item.values.indexOf(item.currentValue);
						const nextIdx = (curIdx + 1) % item.values.length;
						item.currentValue = item.values[nextIdx];

						const { patch } = createPatchForSetting(item.id, item.currentValue);
						if (item.isGlobal) {
							saveGlobalKernelConfig(patch);
							ctx.ui?.notify?.(
								`Saved '${item.label}' = '${item.currentValue}' globally (~/.pi/agent/config.toml)`,
								"info",
							);
						} else {
							saveProjectKernelConfig(currentCwd, patch);
							ctx.ui?.notify?.(
								`Saved '${item.label}' = '${item.currentValue}' to project (.pi/config.toml)`,
								"info",
							);
						}
						deps.invalidateConfig(currentCwd, ctx);
						deps.clearCaches?.();
					}

					toggleGlobalSetting() {
						const item = this.filteredItems[this.selectedIndex];
						if (!item) return;

						const meta = getSettingSectionAndKey(item.id);
						if (!meta) return;

						if (item.isGlobal) {
							// Revert/remove single setting from global config
							removeGlobalKernelConfigKey(meta.section, meta.key);
							item.isGlobal = false;
							deps.invalidateConfig(currentCwd, ctx);
							deps.clearCaches?.();

							ctx.ui?.notify?.(
								`Reverted '${item.label}' from global (now using workspace/default)`,
								"info",
							);
						} else {
							// Apply single setting to global config
							const { patch } = createPatchForSetting(item.id, item.currentValue);
							saveGlobalKernelConfig(patch);
							item.isGlobal = true;
							deps.invalidateConfig(currentCwd, ctx);
							deps.clearCaches?.();

							ctx.ui?.notify?.(
								`Applied '${item.label}' = '${item.currentValue}' globally to ~/.pi/agent/config.toml`,
								"info",
							);
						}
					}

					jumpCategory(forward = true) {
						if (this.filteredItems.length === 0) return;
						const curCat = this.filteredItems[this.selectedIndex]?.category;
						if (forward) {
							const nextIdx = this.filteredItems.findIndex(
								(item, idx) => idx > this.selectedIndex && item.category !== curCat,
							);
							if (nextIdx !== -1) {
								this.selectedIndex = nextIdx;
							} else {
								this.selectedIndex = 0;
							}
						} else {
							let prevIdx = -1;
							for (let i = this.selectedIndex - 1; i >= 0; i--) {
								if (this.filteredItems[i].category !== curCat) {
									prevIdx = i;
									break;
								}
							}
							if (prevIdx !== -1) {
								const prevCat = this.filteredItems[prevIdx].category;
								const firstOfPrev = this.filteredItems.findIndex((item) => item.category === prevCat);
								this.selectedIndex = firstOfPrev !== -1 ? firstOfPrev : prevIdx;
							} else {
								this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
							}
						}
					}

					handleInput(data: string) {
						const kb = getKeybindings();
						if (kb.matches(data, "tui.select.up")) {
							if (this.filteredItems.length === 0) return;
							this.selectedIndex =
								this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
						} else if (kb.matches(data, "tui.select.down")) {
							if (this.filteredItems.length === 0) return;
							this.selectedIndex =
								this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
						} else if (data === "\t") {
							this.jumpCategory(true);
						} else if (data === "\x1b[Z") {
							this.jumpCategory(false);
						} else if (data === "G" || data === "\x07") {
							// Hotkey G toggles global application for currently selected single setting
							this.toggleGlobalSetting();
						} else if (
							kb.matches(data, "tui.select.confirm") ||
							(data === " " && this.searchInput.getValue().length === 0)
						) {
							this.activateItem();
						} else if (kb.matches(data, "tui.select.cancel")) {
							this.onCancel();
						} else {
							this.searchInput.handleInput(data);
							this.applyFilter(this.searchInput.getValue());
						}
					}

					invalidate() {}

					render(width: number): string[] {
						const lines: string[] = [];
						lines.push(...this.searchInput.render(width));
						lines.push("");

						if (this.filteredItems.length === 0) {
							lines.push(this.theme.hint("  No matching settings"));
							lines.push("");
							lines.push(
								this.theme.hint("  Type to search · Enter/Space to change · Esc to cancel"),
							);
							return lines;
						}

						const maxLabelWidth = Math.min(
							38,
							Math.max(...this.filteredItems.map((i) => visibleWidth(i.label))),
						);
						let currentCat: string | null = null;

						for (let i = 0; i < this.filteredItems.length; i++) {
							const item = this.filteredItems[i];
							if (item.category !== currentCat) {
								currentCat = item.category;
								if (lines.length > 2) lines.push("");
								lines.push(`  ${this.theme.category(`[${currentCat}]`)}`);
							}
							const isSelected = i === this.selectedIndex;
							const prefix = isSelected ? this.theme.cursor : "    ";
							const prefixWidth = visibleWidth(prefix);
							const labelPadded =
								item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
							const labelText = this.theme.label(labelPadded, isSelected);
							const separator = "  ";
							const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
							const valueMaxWidth = Math.max(10, width - usedWidth - 2);
							const truncatedVal = truncateToWidth(item.currentValue, valueMaxWidth, "");

							// The right side of the text is YELLOW as the indicator that it is applied globally
							let valueText: string;
							if (item.isGlobal) {
								const yellowStr = theme?.fg
									? theme.fg("warning", truncatedVal)
									: `\x1b[33m${truncatedVal}\x1b[0m`;
								valueText = isSelected
									? theme?.fg
										? theme.bold(yellowStr)
										: `\x1b[1;33m${truncatedVal}\x1b[0m`
									: yellowStr;
							} else {
								valueText = this.theme.value(truncatedVal, isSelected);
							}

							lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
						}

						const selectedItem = this.filteredItems[this.selectedIndex];
						const currentDesc = selectedItem?.descriptions?.[selectedItem.currentValue] || "";
						if (currentDesc) {
							lines.push("");
							const wrapped = wrapTextWithAnsi(currentDesc, width - 6);
							for (const line of wrapped) {
								lines.push(this.theme.description(`    ${line}`));
							}
						}

						lines.push("");
						lines.push(
							this.theme.hint(
								"  Type to search · Enter/Space change · G toggle global · Tab category · Esc cancel",
							),
						);
						return lines;
					}
				}

				const container = new Container();
				const borderColor = (s: string) => (theme?.fg ? theme.fg("border", s) : `\x1b[38;5;240m${s}\x1b[0m`);

				// Top border (identical to thinking/settings selector)
				container.addChild(new DynamicBorder(borderColor));
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme?.fg ? theme.fg("accent", theme.bold("Agent Kernel Settings")) : "Agent Kernel Settings",
						0,
						0,
					),
				);
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme?.fg
							? theme.fg(
									"muted",
									"Yellow text indicates global settings (~/.pi/agent/config.toml) · Press G to toggle",
								)
							: "Yellow text indicates global settings (~/.pi/agent/config.toml) · Press G to toggle",
						0,
						0,
					),
				);
				container.addChild(new Spacer(1));

				const listTheme = {
					category: (text: string) =>
						theme?.fg ? theme.fg("accent", theme.bold(text)) : `\x1b[1;34m${text}\x1b[0m`,
					label: (text: string, selected: boolean) =>
						selected ? (theme?.fg ? theme.fg("accent", text) : `\x1b[36m${text}\x1b[0m`) : text,
					value: (text: string, selected: boolean) =>
						selected
							? theme?.fg
								? theme.fg("accent", text)
								: `\x1b[36m${text}\x1b[0m`
							: theme?.fg
								? theme.fg("muted", text)
								: `\x1b[90m${text}\x1b[0m`,
					scope: (text: string) => (theme?.fg ? theme.fg("muted", text) : `\x1b[90m${text}\x1b[0m`),
					description: (text: string) => (theme?.fg ? theme.fg("dim", text) : `\x1b[2m${text}\x1b[0m`),
					cursor: theme?.fg ? `  ${theme.fg("accent", "→ ")}` : "  \x1b[36m→ \x1b[0m",
					hint: (text: string) => (theme?.fg ? theme.fg("dim", text) : `\x1b[2m${text}\x1b[0m`),
				};

				const settingsList = new CategorizedSettingsList(
					items,
					listTheme,
					() => {
						done(undefined);
					},
					CATEGORY_ORDER,
				);

				container.addChild(settingsList);
				// Bottom border (identical to thinking/settings selector)
				container.addChild(new DynamicBorder(borderColor));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						settingsList.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
