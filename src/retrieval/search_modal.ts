import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../ui/tui_utils";
import { HybridSearchIndex } from "./search_index";
import { SearchProfile } from "./search_config";
import {
	loadKernelConfig,
	saveGlobalKernelConfig,
	saveProjectKernelConfig,
	removeGlobalKernelConfigKey,
	removeProjectKernelConfigKey,
	getGlobalRawConfig,
	getProjectRawConfig,
	mergeDeep,
	type KernelConfig,
	type KernelConfigOverrides,
} from "../config/kernel_config";

export interface ModalResult {
	action: string;
	profile?: SearchProfile;
	reindexed?: boolean;
	excludedPathsChanged?: boolean;
}

export interface ScopeTreeNode {
	id: string; // e.g. "src" or "src/retrieval/search_index.ts"
	name: string; // basename
	relPath: string; // forward-slash relative path
	isDir: boolean;
	depth: number;
	expanded: boolean;
	children: ScopeTreeNode[];
	parent?: ScopeTreeNode;
	fileCount: number;
	chunkCount: number;
	sizeBytes?: number;
}

export interface UnifiedModalOptions {
	initialTab?: 0 | 1 | 2; // 0 = Kernel Settings, 1 = Retrieval Engine, 2 = File Index Scope
	cwd?: string;
	deps?: {
		getConfig: (cwd: string) => KernelConfig;
		invalidateConfig: (cwd: string, ctx?: any) => void;
		clearCaches?: () => void;
		getSearchIndex?: (cwd: string) => any;
		triggerBackgroundIndexing?: (index: any, ctx: any, isFullSync?: boolean) => void;
	};
	ctx?: any;
	keybindings?: { matches?: (data: string, keybinding: string) => boolean };
}

class SearchInput {
	private value = "";
	getValue(): string {
		return this.value;
	}
	setValue(v: string): void {
		this.value = v;
	}
	handleInput(data: string): void {
		if (data === "\x7f" || data === "\b" || /^\x1b\[127(?:;1(?::[12])?)?u$/.test(data)) {
			this.value = this.value.slice(0, -1);
		} else if (matchesKey(data, "space")) {
			this.value += " ";
		} else if (data.length === 1 && data >= " " && data <= "~") {
			this.value += data;
		}
	}
	render(width: number, theme?: any): string[] {
		const label = theme?.fg ? theme.fg("dim", "  Filter settings: ") : "  Filter settings: ";
		const valText = this.value
			? (theme?.fg ? theme.fg("accent", this.value) : this.value)
			: (theme?.fg ? theme.fg("dim", "(type to filter)") : "(type to filter)");
		return [truncateToWidth(label + valText, width)];
	}
}

function fuzzyFilter<T>(items: T[], query: string, textFn: (item: T) => string): T[] {
	if (!query) return items;
	const lower = query.toLowerCase();
	return items.filter((item) => textFn(item).toLowerCase().includes(lower));
}

interface CategorizedSettingItem {
	category: string;
	id: string;
	label: string;
	currentValue: string;
	values: string[];
	descriptions: Record<string, string>;
	isGlobal: boolean;
}

export class UnifiedControlModal implements Focusable {
	focused = false;

	private tui: any;
	private index: HybridSearchIndex;
	private theme: Theme;
	private done: (result: ModalResult | undefined) => void;
	private options: UnifiedModalOptions;
	private currentCwd: string;

	// Active tab: 0 = Kernel Settings, 1 = Retrieval Engine, 2 = File Index Scope
	private activeTab: 0 | 1 | 2 = 0;

	// -------------------------------------------------------------------------
	// TAB 0: KERNEL SETTINGS STATE
	// -------------------------------------------------------------------------
	private settingsItems: CategorizedSettingItem[] = [];
	private filteredSettingsItems: CategorizedSettingItem[] = [];
	private settingsSelectedIndex = 0;
	private searchInput: SearchInput;
	private initialSettingStates = new Map<string, { value: string; isGlobal: boolean }>();
	private categoryOrder = [
		"Retrieval & Exploration",
		"Safety & Verification",
		"Editing Engine",
		"System Guidance & UI",
	];

	// -------------------------------------------------------------------------
	// TAB 1: RETRIEVAL ENGINE STATE
	// -------------------------------------------------------------------------
	private initialProfile: SearchProfile;
	private selectedProfile: SearchProfile;
	private profileSelectedIndex = 0;
	private profileItems: Array<{
		id: string;
		category: "profile" | "action";
		label: string;
		desc: string;
		profile?: SearchProfile;
	}> = [
		{
			id: "auto",
			category: "profile",
			profile: "auto",
			label: "Auto Detect",
			desc: "Auto-detect Lean (fewer than 4 CPUs) or Full (4 or more)",
		},
		{
			id: "lean",
			category: "profile",
			profile: "lean",
			label: "Lean Mode",
			desc: "AST BM25 (0% CPU, 0 MB extra RAM)",
		},
		{
			id: "full",
			category: "profile",
			profile: "full",
			label: "Full Mode",
			desc: "BM25 + 768-dim code embeddings",
		},
		{
			id: "off",
			category: "profile",
			profile: "off",
			label: "Disable Engine",
			desc: "Turn off search & free memory",
		},
		{
			id: "reindex",
			category: "action",
			label: "Re-index Workspace",
			desc: "Scan all source files and rebuild index",
		},
		{
			id: "close",
			category: "action",
			label: "Close Panel",
			desc: "Dismiss this dialog and apply changes",
		},
	];

	// -------------------------------------------------------------------------
	// TAB 2: FILE INDEX SCOPE STATE
	// -------------------------------------------------------------------------
	private treeRoots: ScopeTreeNode[] = [];
	private treeCursorIndex = 0;
	private treeScrollOffset = 0;
	private excludedPaths: Set<string>;
	private initialExcludedPaths: Set<string>;

	constructor(
		tui: any,
		index: HybridSearchIndex,
		theme: Theme,
		done: (result: ModalResult | undefined) => void,
		options: UnifiedModalOptions = {},
	) {
		this.tui = tui;
		this.index = index;
		this.theme = theme;
		this.done = done;
		this.options = options;
		this.currentCwd = options.cwd || (index?.getCwd ? index.getCwd() : process.cwd());

		// Tab selection: defaults to options.initialTab if provided,
		// or 1 if invoked as legacy SearchControlModal without options.
		if (options.initialTab !== undefined) {
			this.activeTab = options.initialTab;
		} else {
			this.activeTab = 1;
		}

		// Initial profile setup
		this.initialProfile = index?.getProfile ? index.getProfile() : "lean";
		this.selectedProfile = this.initialProfile === "hybrid" ? "full" : this.initialProfile;
		const pIdx = this.profileItems.findIndex((item) => item.profile === this.selectedProfile);
		if (pIdx >= 0) this.profileSelectedIndex = pIdx;

		// Excluded paths setup
		this.excludedPaths = new Set(index?.getExcludedPaths ? index.getExcludedPaths() : []);
		this.initialExcludedPaths = new Set(this.excludedPaths);

		// Initialize Tab 0 Settings
		this.searchInput = new SearchInput();
		this.initSettingsTab();

		// Initialize Tab 2 Scope Tree
		this.buildScopeTree();
	}

	// =========================================================================
	// TAB 0: KERNEL SETTINGS LOGIC
	// =========================================================================
	private initSettingsTab(): void {
		const currentConfig = this.options.deps?.getConfig
			? this.options.deps.getConfig(this.currentCwd)
			: loadKernelConfig(this.currentCwd);

		const globalRaw = getGlobalRawConfig();
		const projectTrusted = this.options.ctx?.isProjectTrusted?.() !== false;
		const projectRaw = projectTrusted ? getProjectRawConfig(this.currentCwd) : {};
		const isOverriddenByProject = (section: string, key: string): boolean =>
			projectRaw[section]?.[key] !== undefined;
		const checkIsGlobal = (id: string): boolean => {
			if (id === "profile") return !isOverriddenByProject("retrieval", "default_profile") && globalRaw.retrieval?.default_profile !== undefined;
			if (id === "epistemic") return !isOverriddenByProject("safety", "enable_epistemic_guard") && globalRaw.safety?.enable_epistemic_guard !== undefined;
			if (id === "max_lines") return !isOverriddenByProject("safety", "max_lines") && globalRaw.safety?.max_lines !== undefined;
			if (id === "editing") return !isOverriddenByProject("editing", "mode") && globalRaw.editing?.mode !== undefined;
			if (id === "read_mode") return !isOverriddenByProject("editing", "read_mode") && globalRaw.editing?.read_mode !== undefined;
			if (id === "normalize_dots") return !isOverriddenByProject("editing", "normalize_fullwidth_dots") && globalRaw.editing?.normalize_fullwidth_dots !== undefined;
			if (id === "guidance") return !isOverriddenByProject("instructions", "enabled") && globalRaw.instructions?.enabled !== undefined;
			if (id === "host_environment") return !isOverriddenByProject("instructions", "host_environment") && globalRaw.instructions?.host_environment !== undefined;
			if (id === "pi_docs") return !isOverriddenByProject("instructions", "pi_docs") && globalRaw.instructions?.pi_docs !== undefined;
			if (id === "footer") return !isOverriddenByProject("ui", "enable_pastel_footer") && globalRaw.ui?.enable_pastel_footer !== undefined;
			return false;
		};

		const normalizedProfile = currentConfig.retrieval.default_profile === "hybrid"
			? "full"
			: currentConfig.retrieval.default_profile;
		if (!this.index?.getProfile) {
			this.initialProfile = normalizedProfile;
			this.selectedProfile = normalizedProfile;
			const pIdx = this.profileItems.findIndex((item) => item.profile === this.selectedProfile);
			if (pIdx >= 0) this.profileSelectedIndex = pIdx;
		}

		this.settingsItems = [
			{
				category: "Retrieval & Exploration",
				id: "profile",
				label: "Retrieval Engine Profile",
				currentValue: normalizedProfile,
				values: ["auto", "lean", "full", "off"],
				isGlobal: checkIsGlobal("profile"),
				descriptions: {
					auto: "Auto profile: Selects lean below 4 CPU cores and full otherwise.",
					lean: "Lean profile: BM25 keyword index + AST code chunking. Zero RAM overhead, sub-millisecond retrieval.",
					full: "Full profile: BM25 keyword index fused with 768d gte-modernbert-base code embeddings (~147 MB model).",
					hybrid: "Hybrid: alias of the full profile.",
					off: "Off profile: Retrieval subsystem disabled. code_search returns an error.",
				},
			},
			{
				category: "Safety & Verification",
				id: "epistemic",
				label: "Epistemic Guard (Read-before-write)",
				currentValue: currentConfig.safety.enable_epistemic_guard ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
				isGlobal: checkIsGlobal("epistemic"),
				descriptions: {
					enabled: "Epistemic Guard active: Enforces strict read-before-write validation, preventing hallucinated edits.",
					disabled: "Epistemic Guard inactive: Allows unconstrained edits without prior read operations.",
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
					"40 lines": "40 lines maximum: Compact output windowing, best for low-context models.",
					"100 lines": "100 lines maximum (recommended default): Balanced diagnostic context with spillover logging.",
					"200 lines": "200 lines maximum: Expansive terminal output for deep test traces and large outputs.",
				},
			},
			{
				category: "Editing Engine",
				id: "editing",
				label: "Editing Mode (Smart Anchors)",
				currentValue: currentConfig.editing.mode === "smart_anchor" ? "smart_anchor" : "standard",
				values: ["smart_anchor", "standard"],
				isGlobal: checkIsGlobal("editing"),
				descriptions: {
					smart_anchor: "Smart Anchors: syntax validation, lexical delimiter balancing, and line-hint disambiguation.",
					standard: "Standard editing: exact string replacement with delimiter auto-healing disabled.",
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
					plain: "Plain text reads: Clean, unanchored reading protocol. Reduces token consumption by ~84%.",
					anchored: "Anchored reads: Injects LINE#HASH prefixes on every line for strict positional pinning.",
					auto: "Adaptive reading: Defaults to clean plain text, automatically falling back to anchored reads when resolving ambiguous edit targets.",
				},
			},
			{
				category: "Editing Engine",
				id: "normalize_dots",
				label: "Fullwidth Dot Normalization",
				currentValue: currentConfig.editing.normalize_fullwidth_dots !== false ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
				isGlobal: checkIsGlobal("normalize_dots"),
				descriptions: {
					enabled: "Fullwidth dot normalization enabled: Converts Unicode fullwidth full stop (U+FF0E '．') to ASCII '.' in edit operations.",
					disabled: "Fullwidth dot normalization disabled: Preserves Unicode fullwidth full stop verbatim.",
				},
			},
			{
				category: "System Guidance & UI",
				id: "guidance",
				label: "Agent Guidance Prompt",
				currentValue: currentConfig.instructions.enabled ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
				isGlobal: checkIsGlobal("guidance"),
				descriptions: {
					enabled: "Kernel guidance active: Injects empirical tool discipline, grounding rules, and search strategies into the system prompt.",
					disabled: "Kernel guidance inactive: Omits kernel prompt injection, running with default model prompt.",
				},
			},
			{
				category: "System Guidance & UI",
				id: "host_environment",
				label: "Host Environment Info",
				currentValue: currentConfig.instructions.host_environment !== false ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
				isGlobal: checkIsGlobal("host_environment"),
				descriptions: {
					enabled: "Host environment active: Injects factual host OS, shell, line ending policy, and toolchain versions into system prompt.",
					disabled: "Host environment inactive: Omits host platform and toolchain probing from system prompt.",
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
					enabled: "Pi docs included: Injects documentation guidance for Pi extensions, tools, and theme authoring.",
					disabled: "Pi docs omitted: Strips the Pi documentation block to optimize prompt cache hit rate and token consumption.",
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
					enabled: "Pastel footer active: Displays terminal statusline at bottom showing active model, search index, and memory.",
					disabled: "Pastel footer inactive: Disables bottom statusline for an uncluttered minimal workspace.",
				},
			},
		];

		this.filteredSettingsItems = this.settingsItems;
		for (const item of this.settingsItems) {
			this.initialSettingStates.set(item.id, {
				value: item.currentValue,
				isGlobal: Boolean(item.isGlobal),
			});
		}
	}

	private applySettingsFilter(query: string): void {
		if (query) {
			const matches = fuzzyFilter(
				this.settingsItems,
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
			this.filteredSettingsItems = result;
		} else {
			this.filteredSettingsItems = this.settingsItems;
		}
		this.settingsSelectedIndex = 0;
	}

	private syncProfileSelection(profile: SearchProfile): void {
		const normalized = profile === "hybrid" ? "full" : profile;
		this.selectedProfile = normalized;
		const pIdx = this.profileItems.findIndex((pi) => pi.profile === normalized);
		if (pIdx >= 0) this.profileSelectedIndex = pIdx;
		const profileSetting = this.settingsItems.find((s) => s.id === "profile");
		if (profileSetting) {
			profileSetting.currentValue = normalized;
		}
	}

	private activateSettingItem(): void {
		const item = this.filteredSettingsItems[this.settingsSelectedIndex];
		if (!item || !item.values || item.values.length === 0) return;
		const curIdx = item.values.indexOf(item.currentValue);
		const nextIdx = (curIdx + 1) % item.values.length;
		item.currentValue = item.values[nextIdx];

		// If profile setting was cycled in Tab 0, keep Tab 1 in sync
		if (item.id === "profile") {
			this.syncProfileSelection(item.currentValue as SearchProfile);
		}
	}

	private toggleGlobalSetting(): void {
		const item = this.filteredSettingsItems[this.settingsSelectedIndex];
		if (!item) return;
		item.isGlobal = !item.isGlobal;
	}

	private applySettingsChanges(): boolean {
		let hasChanges = false;
		const globalUpdates: KernelConfigOverrides = {};
		const projectUpdates: KernelConfigOverrides = {};
		const revertedGlobals: Array<{ section: string; key: string }> = [];
		const revertedProjects: Array<{ section: string; key: string }> = [];

		const createPatchForSetting = (id: string, value: string): { patch: KernelConfigOverrides } => {
			const patch: KernelConfigOverrides = {};
			if (id === "profile") {
				patch.retrieval = { default_profile: value as "auto" | "lean" | "hybrid" | "full" | "off" };
			} else if (id === "epistemic") {
				patch.safety = { enable_epistemic_guard: value === "enabled" };
			} else if (id === "editing") {
				patch.editing = { mode: value as "smart_anchor" | "standard" };
			} else if (id === "read_mode") {
				patch.editing = { read_mode: value as "auto" | "plain" | "anchored" };
			} else if (id === "normalize_dots") {
				patch.editing = { normalize_fullwidth_dots: value === "enabled" };
			} else if (id === "guidance") {
				patch.instructions = { enabled: value === "enabled" };
			} else if (id === "host_environment") {
				patch.instructions = { host_environment: value === "enabled" };
			} else if (id === "pi_docs") {
				patch.instructions = { pi_docs: value === "enabled" };
			} else if (id === "footer") {
				patch.ui = { enable_pastel_footer: value === "enabled" };
			} else if (id === "max_lines") {
				const num = parseInt(value, 10);
				if (Number.isSafeInteger(num)) {
					patch.safety = { max_lines: num };
				}
			}
			return { patch };
		};

		const getSettingSectionAndKey = (id: string): { section: string; key: string } | null => {
			switch (id) {
				case "profile": return { section: "retrieval", key: "default_profile" };
				case "epistemic": return { section: "safety", key: "enable_epistemic_guard" };
				case "max_lines": return { section: "safety", key: "max_lines" };
				case "editing": return { section: "editing", key: "mode" };
				case "read_mode": return { section: "editing", key: "read_mode" };
				case "normalize_dots": return { section: "editing", key: "normalize_fullwidth_dots" };
				case "guidance": return { section: "instructions", key: "enabled" };
				case "host_environment": return { section: "instructions", key: "host_environment" };
				case "pi_docs": return { section: "instructions", key: "pi_docs" };
				case "footer": return { section: "ui", key: "enable_pastel_footer" };
				default: return null;
			}
		};

		for (const item of this.settingsItems) {
			const initial = this.initialSettingStates.get(item.id);
			if (!initial) continue;

			const valueChanged = item.currentValue !== initial.value;
			const scopeChanged = Boolean(item.isGlobal) !== Boolean(initial.isGlobal);

			if (valueChanged || scopeChanged) {
				hasChanges = true;
				const { patch } = createPatchForSetting(item.id, item.currentValue);

				if (item.isGlobal) {
					mergeDeep(globalUpdates, patch);
					if (!initial.isGlobal) {
						const meta = getSettingSectionAndKey(item.id);
						if (meta) revertedProjects.push(meta);
					}
				} else {
					if (initial.isGlobal) {
						const meta = getSettingSectionAndKey(item.id);
						if (meta) revertedGlobals.push(meta);
					}
					mergeDeep(projectUpdates, patch);
				}
			}
		}

		if (hasChanges) {
			try {
				if (Object.keys(globalUpdates).length > 0) {
					saveGlobalKernelConfig(globalUpdates);
				}
				if (Object.keys(projectUpdates).length > 0) {
					saveProjectKernelConfig(this.currentCwd, projectUpdates);
				}
				for (const { section, key } of revertedGlobals) {
					removeGlobalKernelConfigKey(section, key);
				}
				for (const { section, key } of revertedProjects) {
					removeProjectKernelConfigKey(this.currentCwd, section, key);
				}

				this.options.deps?.invalidateConfig?.(this.currentCwd, this.options.ctx);
				this.options.deps?.clearCaches?.();
				this.options.ctx?.ui?.notify?.("Applied Agent Kernel configuration changes.", "info");
			} catch (error) {
				console.error("[agent-kernel] Configuration apply failed:", error);
			}
		}
		return hasChanges;
	}

	// =========================================================================
	// TAB 2: FILE INDEX SCOPE LOGIC
	// =========================================================================
	private buildScopeTree(): void {
		const files = this.index?.getIndexableFiles ? this.index.getIndexableFiles() : [];

		for (const relPath of files) {
			const normPath = relPath.replace(/\\/g, "/");
			const parts = normPath.split("/");
			let currentChildren = this.treeRoots;
			let currentParent: ScopeTreeNode | undefined = undefined;
			let currentAccum = "";

			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const isLast = i === parts.length - 1;
				currentAccum = currentAccum ? `${currentAccum}/${part}` : part;

				if (isLast) {
					const chunkCount = this.index?.getChunkCountForFile ? this.index.getChunkCountForFile(normPath) : 1;
					const fileNode: ScopeTreeNode = {
						id: normPath,
						name: part,
						relPath: normPath,
						isDir: false,
						depth: i,
						expanded: false,
						children: [],
						parent: currentParent,
						fileCount: 1,
						chunkCount,
					};
					currentChildren.push(fileNode);
				} else {
					let dirNode = currentChildren.find((c) => c.isDir && c.name === part);
					if (!dirNode) {
						dirNode = {
							id: currentAccum,
							name: part,
							relPath: currentAccum,
							isDir: true,
							depth: i,
							expanded: i === 0,
							children: [],
							parent: currentParent,
							fileCount: 0,
							chunkCount: 0,
						};
						currentChildren.push(dirNode);
					}
					currentParent = dirNode;
					currentChildren = dirNode.children;
				}
			}
		}

		const aggregateCounts = (nodes: ScopeTreeNode[]): { files: number; chunks: number } => {
			let totalFiles = 0;
			let totalChunks = 0;
			for (const node of nodes) {
				if (node.isDir) {
					const sub = aggregateCounts(node.children);
					node.fileCount = sub.files;
					node.chunkCount = sub.chunks;
					totalFiles += sub.files;
					totalChunks += sub.chunks;
				} else {
					totalFiles += 1;
					totalChunks += node.chunkCount;
				}
			}
			nodes.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
			return { files: totalFiles, chunks: totalChunks };
		};

		aggregateCounts(this.treeRoots);
	}

	private isPathExcluded(relPath: string): boolean {
		const norm = relPath.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
		for (const p of this.excludedPaths) {
			const cleanP = p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
			if (!cleanP) continue;
			if (norm === cleanP || norm.startsWith(cleanP + "/")) {
				return true;
			}
		}
		return false;
	}

	private getFolderSelectionState(node: ScopeTreeNode): "all" | "some" | "none" {
		let total = 0;
		let selected = 0;

		const check = (n: ScopeTreeNode) => {
			for (const child of n.children) {
				if (child.isDir) {
					check(child);
				} else {
					total++;
					if (!this.isPathExcluded(child.relPath)) {
						selected++;
					}
				}
			}
		};
		check(node);

		if (total === 0) return "all";
		if (selected === total) return "all";
		if (selected === 0) return "none";
		return "some";
	}

	private unexcludeNode(node: ScopeTreeNode): void {
		this.excludedPaths.delete(node.relPath);

		const clearChildren = (n: ScopeTreeNode) => {
			for (const c of n.children) {
				this.excludedPaths.delete(c.relPath);
				if (c.isDir) clearChildren(c);
			}
		};
		if (node.isDir) clearChildren(node);

		let p = node.parent;
		while (p) {
			if (this.excludedPaths.has(p.relPath)) {
				this.excludedPaths.delete(p.relPath);
				const excludeSubtreeExcept = (dir: ScopeTreeNode, targetPath: string) => {
					for (const c of dir.children) {
						if (c.relPath === targetPath) continue;
						if (c.isDir) {
							if (targetPath.startsWith(c.relPath + "/")) {
								excludeSubtreeExcept(c, targetPath);
							} else {
								this.excludedPaths.add(c.relPath);
							}
						} else {
							this.excludedPaths.add(c.relPath);
						}
					}
				};
				excludeSubtreeExcept(p, node.relPath);
			}
			p = p.parent;
		}
	}

	private toggleNodeSelection(node: ScopeTreeNode): void {
		if (!node.isDir) {
			const isExcluded = this.isPathExcluded(node.relPath);
			if (isExcluded) {
				this.unexcludeNode(node);
			} else {
				this.excludedPaths.add(node.relPath);
			}
		} else {
			const state = this.getFolderSelectionState(node);
			if (state === "all") {
				this.excludedPaths.add(node.relPath);
				const clearSub = (dir: ScopeTreeNode) => {
					for (const c of dir.children) {
						this.excludedPaths.delete(c.relPath);
						if (c.isDir) clearSub(c);
					}
				};
				clearSub(node);
			} else {
				this.unexcludeNode(node);
			}
		}
		this.tui?.requestRender?.();
	}

	private getVisibleTreeNodes(): ScopeTreeNode[] {
		const visible: ScopeTreeNode[] = [];
		const traverse = (nodes: ScopeTreeNode[]) => {
			for (const node of nodes) {
				visible.push(node);
				if (node.isDir && node.expanded) {
					traverse(node.children);
				}
			}
		};
		traverse(this.treeRoots);
		return visible;
	}

	private hasExcludedPathsChanged(): boolean {
		if (this.excludedPaths.size !== this.initialExcludedPaths.size) return true;
		for (const p of this.excludedPaths) {
			if (!this.initialExcludedPaths.has(p)) return true;
		}
		return false;
	}

	private matchesBinding(data: string, keybinding: string, fallbackKey: string): boolean {
		return Boolean(this.options.keybindings?.matches?.(data, keybinding)) || matchesKey(data, fallbackKey);
	}

	// =========================================================================
	// KEYBOARD INPUT DISPATCHER
	// =========================================================================
	async handleInput(data: string): Promise<void> {
		// Universal dismiss on Esc / q
		if (
			this.matchesBinding(data, "tui.select.cancel", "escape") ||
			matchesKey(data, "q") ||
			matchesKey(data, "ctrl+c")
		) {
			this.finishModal("close");
			return;
		}

		// Universal Tab switching: 0 -> 1 -> 2 -> 0
		if (matchesKey(data, "tab")) {
			this.activeTab = ((this.activeTab + 1) % 3) as 0 | 1 | 2;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "1") {
			this.activeTab = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "2") {
			this.activeTab = 1;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "3") {
			this.activeTab = 2;
			this.tui?.requestRender?.();
			return;
		}

		// ------------------ DISPATCH: TAB 0 (KERNEL SETTINGS) ------------------
		if (this.activeTab === 0) {
			if (data === "G" || data === "\x07") {
				this.toggleGlobalSetting();
				this.tui?.requestRender?.();
				return;
			}
			if (
				this.matchesBinding(data, "tui.select.confirm", "return") ||
				(matchesKey(data, "space") && this.searchInput.getValue().length === 0)
			) {
				this.activateSettingItem();
				this.tui?.requestRender?.();
				return;
			}
			if (this.matchesBinding(data, "tui.select.up", "up") || matchesKey(data, "k")) {
				if (this.filteredSettingsItems.length > 0) {
					this.settingsSelectedIndex =
						this.settingsSelectedIndex === 0
							? this.filteredSettingsItems.length - 1
							: this.settingsSelectedIndex - 1;
					this.tui?.requestRender?.();
				}
				return;
			}
			if (this.matchesBinding(data, "tui.select.down", "down") || matchesKey(data, "j")) {
				if (this.filteredSettingsItems.length > 0) {
					this.settingsSelectedIndex =
						this.settingsSelectedIndex === this.filteredSettingsItems.length - 1
							? 0
							: this.settingsSelectedIndex + 1;
					this.tui?.requestRender?.();
				}
				return;
			}

			// Forward typing to search bar
			this.searchInput.handleInput(data);
			this.applySettingsFilter(this.searchInput.getValue());
			this.tui?.requestRender?.();
			return;
		}

		// ------------------ DISPATCH: TAB 1 (RETRIEVAL ENGINE) ------------------
		if (this.activeTab === 1) {
			if (matchesKey(data, "left") || matchesKey(data, "h")) {
				this.activeTab = 0;
				this.tui?.requestRender?.();
				return;
			}
			if (matchesKey(data, "right") || matchesKey(data, "l")) {
				this.activeTab = 2;
				this.tui?.requestRender?.();
				return;
			}

			if (this.matchesBinding(data, "tui.select.up", "up") || matchesKey(data, "k")) {
				this.profileSelectedIndex =
					(this.profileSelectedIndex - 1 + this.profileItems.length) % this.profileItems.length;
				this.tui?.requestRender?.();
				return;
			}

			if (this.matchesBinding(data, "tui.select.down", "down") || matchesKey(data, "j")) {
				this.profileSelectedIndex = (this.profileSelectedIndex + 1) % this.profileItems.length;
				this.tui?.requestRender?.();
				return;
			}

			if (this.matchesBinding(data, "tui.select.confirm", "return") || matchesKey(data, "space")) {
				const item = this.profileItems[this.profileSelectedIndex];
				if (!item) return;

				if (item.category === "profile" && item.profile) {
					this.syncProfileSelection(item.profile);
					this.tui?.requestRender?.();
					return;
				}

				if (item.id === "reindex") {
					this.finishModal("reindex");
					return;
				}

				if (item.id === "close") {
					this.finishModal("close");
					return;
				}
			}
			return;
		}

		// ------------------ DISPATCH: TAB 2 (FILE INDEX SCOPE) ------------------
		const visibleNodes = this.getVisibleTreeNodes();
		if (visibleNodes.length === 0) {
			if (matchesKey(data, "left") || matchesKey(data, "h")) {
				this.activeTab = 1;
				this.tui?.requestRender?.();
			}
			return;
		}

		if (this.treeCursorIndex >= visibleNodes.length) {
			this.treeCursorIndex = Math.max(0, visibleNodes.length - 1);
		}
		const currentNode = visibleNodes[this.treeCursorIndex];

		if (this.matchesBinding(data, "tui.select.up", "up") || matchesKey(data, "k")) {
			this.treeCursorIndex = Math.max(0, this.treeCursorIndex - 1);
			this.tui?.requestRender?.();
			return;
		}

		if (this.matchesBinding(data, "tui.select.down", "down") || matchesKey(data, "j")) {
			this.treeCursorIndex = Math.min(visibleNodes.length - 1, this.treeCursorIndex + 1);
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			if (currentNode && currentNode.isDir && currentNode.expanded) {
				currentNode.expanded = false;
				this.tui?.requestRender?.();
				return;
			}
			if (currentNode && currentNode.parent) {
				const parentIdx = visibleNodes.findIndex((n) => n.id === currentNode.parent?.id);
				if (parentIdx >= 0) {
					this.treeCursorIndex = parentIdx;
					this.tui?.requestRender?.();
					return;
				}
			}
			this.activeTab = 1;
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			if (currentNode && currentNode.isDir && !currentNode.expanded) {
				currentNode.expanded = true;
				this.tui?.requestRender?.();
				return;
			}
		}

		if (matchesKey(data, "space") || data === "x" || data === "X") {
			if (currentNode) {
				this.toggleNodeSelection(currentNode);
			}
			return;
		}

		if (this.matchesBinding(data, "tui.select.confirm", "return")) {
			if (currentNode) {
				if (currentNode.isDir) {
					currentNode.expanded = !currentNode.expanded;
					this.tui?.requestRender?.();
				} else {
					this.toggleNodeSelection(currentNode);
				}
			}
		}
	}

	private finishModal(action: "select" | "reindex" | "close"): void {
		// 1. Commit any changes from Tab 0 & Tab 1 (profile selection is synchronized into Tab 0)
		this.applySettingsChanges();

		const initialNormalized = this.initialProfile === "hybrid" ? "full" : this.initialProfile;
		const profileChanged = this.selectedProfile !== initialNormalized;
		if (profileChanged && !this.options.deps?.invalidateConfig) {
			this.index?.setProfile?.(this.selectedProfile);
		}
		const currentProfile = this.index?.getProfile ? this.index.getProfile() : this.selectedProfile;

		// 2. Commit any changes from Tab 2 Scope
		const hasScopeChanges = this.hasExcludedPathsChanged();
		if (hasScopeChanges) {
			if (this.index?.setExcludedPaths) {
				this.index.setExcludedPaths(this.excludedPaths);
			}
			try {
				saveProjectKernelConfig(this.currentCwd, {
					retrieval: { excluded_paths: Array.from(this.excludedPaths) },
				});
				this.options.deps?.invalidateConfig?.(this.currentCwd, this.options.ctx);
			} catch (error) {
				console.error("[agent-kernel] Failed to save excluded paths to project config:", error);
			}
		}

		this.done({
			action,
			profile: this.selectedProfile || currentProfile,
			reindexed: action === "reindex" || profileChanged,
			excludedPathsChanged: hasScopeChanges,
		});
	}

	invalidate(): void {}

	// =========================================================================
	// RENDER DISPATCHER
	// =========================================================================
	render(width: number): string[] {
		const lines: string[] = [];
		const borderColor = (s: string) => (this.theme?.fg ? this.theme.fg("border", s) : `\x1b[38;5;240m${s}\x1b[0m`);

		// Top dynamic border
		lines.push(borderColor("─".repeat(Math.max(1, width))));
		lines.push("");

		// Tab Bar Header (3 Tabs)
		const tab0Active = this.activeTab === 0;
		const tab1Active = this.activeTab === 1;
		const tab2Active = this.activeTab === 2;

		const tab0Text = "Kernel Settings";
		const tab1Text = "Retrieval Engine";
		const tab2Text = "File Index Scope";

		const tab0Rendered = tab0Active
			? (this.theme?.fg ? this.theme.fg("accent", this.theme.bold(tab0Text)) : `\x1b[1;36m${tab0Text}\x1b[0m`)
			: (this.theme?.fg ? this.theme.fg("muted", tab0Text) : `\x1b[90m${tab0Text}\x1b[0m`);

		const tab1Rendered = tab1Active
			? (this.theme?.fg ? this.theme.fg("accent", this.theme.bold(tab1Text)) : `\x1b[1;36m${tab1Text}\x1b[0m`)
			: (this.theme?.fg ? this.theme.fg("muted", tab1Text) : `\x1b[90m${tab1Text}\x1b[0m`);

		const tab2Rendered = tab2Active
			? (this.theme?.fg ? this.theme.fg("accent", this.theme.bold(tab2Text)) : `\x1b[1;36m${tab2Text}\x1b[0m`)
			: (this.theme?.fg ? this.theme.fg("muted", tab2Text) : `\x1b[90m${tab2Text}\x1b[0m`);

		const tabSep = this.theme?.fg ? this.theme.fg("dim", "  │  ") : "  │  ";
		lines.push(`  ${tab0Rendered}${tabSep}${tab1Rendered}${tabSep}${tab2Rendered}`);
		lines.push("");
		lines.push(borderColor("─".repeat(Math.max(1, width))));

		// ------------------ RENDER: TAB 0 (KERNEL SETTINGS) ------------------
		if (this.activeTab === 0) {
			lines.push(...this.searchInput.render(width, this.theme));
			lines.push("");

			if (this.filteredSettingsItems.length === 0) {
				lines.push(this.theme?.fg ? this.theme.fg("dim", "  No matching settings") : "  No matching settings");
				lines.push("");
				lines.push(
					this.theme?.fg
						? this.theme.fg("dim", "  Type to search · Enter/Space to cycle · Esc to cancel")
						: "  Type to search · Enter/Space to cycle · Esc to cancel",
				);
				lines.push(borderColor("─".repeat(Math.max(1, width))));
				return lines;
			}

			const maxLabelWidth = Math.min(
				38,
				Math.max(...this.filteredSettingsItems.map((i) => visibleWidth(i.label))),
			);
			let currentCat: string | null = null;

			for (let i = 0; i < this.filteredSettingsItems.length; i++) {
				const item = this.filteredSettingsItems[i];
				if (item.category !== currentCat) {
					currentCat = item.category;
					if (lines.length > 5) lines.push("");
					const catHeader = this.theme?.fg
						? this.theme.fg("accent", this.theme.bold(`[${currentCat}]`))
						: `\x1b[1;34m[${currentCat}]\x1b[0m`;
					lines.push(`  ${catHeader}`);
				}
				const isSelected = i === this.settingsSelectedIndex;
				const cursor = isSelected
					? (this.theme?.fg ? `  ${this.theme.fg("accent", "→ ")}` : "  \x1b[36m→ \x1b[0m")
					: "    ";
				const labelPadded =
					item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
				const labelText = isSelected
					? (this.theme?.fg ? this.theme.fg("accent", labelPadded) : `\x1b[36m${labelPadded}\x1b[0m`)
					: labelPadded;

				const separator = "  ";
				const prefixWidth = visibleWidth(cursor);
				const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
				const valueMaxWidth = Math.max(10, width - usedWidth - 2);
				const truncatedVal = truncateToWidth(item.currentValue, valueMaxWidth, "");

				let valueText: string;
				if (item.isGlobal) {
					const yellowStr = this.theme?.fg
						? this.theme.fg("warning", truncatedVal)
						: `\x1b[33m${truncatedVal}\x1b[0m`;
					valueText = isSelected
						? (this.theme?.fg ? this.theme.bold(yellowStr) : `\x1b[1;33m${truncatedVal}\x1b[0m`)
						: yellowStr;
				} else {
					valueText = isSelected
						? (this.theme?.fg ? this.theme.fg("accent", truncatedVal) : `\x1b[36m${truncatedVal}\x1b[0m`)
						: (this.theme?.fg ? this.theme.fg("muted", truncatedVal) : `\x1b[90m${truncatedVal}\x1b[0m`);
				}

				lines.push(truncateToWidth(cursor + labelText + separator + valueText, width));
			}

			const selectedItem = this.filteredSettingsItems[this.settingsSelectedIndex];
			const currentDesc = selectedItem?.descriptions?.[selectedItem.currentValue] || "";
			if (currentDesc) {
				lines.push("");
				const wrapped = wrapTextWithAnsi(currentDesc, width - 6);
				for (const line of wrapped) {
					lines.push(this.theme?.fg ? `    ${this.theme.fg("dim", line)}` : `    \x1b[2m${line}\x1b[0m`);
				}
			}

			lines.push("");
			const hintText = "  Type search · Enter/Space cycle · G toggle global · Tab next tab · Esc close & apply";
			lines.push(this.theme?.fg ? this.theme.fg("dim", hintText) : `\x1b[2m${hintText}\x1b[0m`);
			lines.push(borderColor("─".repeat(Math.max(1, width))));
			return lines;
		}

		// ------------------ RENDER: TAB 1 (RETRIEVAL ENGINE) ------------------
		if (this.activeTab === 1) {
			const status = this.index?.getStatus ? this.index.getStatus() : {
				engineState: "ready",
				pipelineDesc: "BM25",
				effectiveProfile: "lean",
				chunkCount: 0,
				fileCount: 0,
				vectorCount: 0,
				rssMemoryMB: 0,
				hardwareInfo: "",
				isModelCached: false,
				modelStatus: "ready",
			};
			const currentProfile = this.selectedProfile;

			const title = this.theme?.fg
				? this.theme.fg("accent", this.theme.bold("Codebase Retrieval Engine"))
				: "\x1b[1;36mCodebase Retrieval Engine\x1b[0m";
			lines.push(`  ${title}`);

			const statusParts = [
				`Status: ${status.engineState}`,
				`Active: ${status.effectiveProfile.toUpperCase()}`,
				`${status.chunkCount} chunks in ${status.fileCount} files`,
			];
			if (status.vectorCount > 0) statusParts.push(`${status.vectorCount} vectors`);
			statusParts.push(`RSS ${status.rssMemoryMB} MB`);
			const statusSummary = statusParts.join(" · ");
			lines.push(this.theme?.fg ? `  ${this.theme.fg("muted", statusSummary)}` : `  \x1b[90m${statusSummary}\x1b[0m`);
			lines.push("");

			let currentCat: string | null = null;
			const maxLabelWidth = 22;

			for (let i = 0; i < this.profileItems.length; i++) {
				const item = this.profileItems[i];
				const catLabel = item.category === "profile" ? "Engine Profiles" : "Workspace Actions";
				if (catLabel !== currentCat) {
					currentCat = catLabel;
					if (lines.length > 7) lines.push("");
					const catHeader = this.theme?.fg
						? this.theme.fg("accent", this.theme.bold(`[${currentCat}]`))
						: `\x1b[1;34m[${currentCat}]\x1b[0m`;
					lines.push(`  ${catHeader}`);
				}

				const isSelected = i === this.profileSelectedIndex;
				const isCurrentProfile =
					item.category === "profile" &&
					item.profile === (currentProfile === "hybrid" ? "full" : currentProfile);

				const cursor = isSelected
					? (this.theme?.fg ? `  ${this.theme.fg("accent", "→ ")}` : "  \x1b[36m→ \x1b[0m")
					: "    ";

				let indicator = " ";
				if (item.category === "profile") {
					indicator = isCurrentProfile
						? (this.theme?.fg ? this.theme.fg("accent", "◉") : "\x1b[36m◉\x1b[0m")
						: (this.theme?.fg ? this.theme.fg("muted", "○") : "\x1b[90m○\x1b[0m");
				} else {
					indicator = item.id === "reindex"
						? (this.theme?.fg ? this.theme.fg("accent", "↺") : "\x1b[36m↺\x1b[0m")
						: (this.theme?.fg ? this.theme.fg("dim", "✕") : "\x1b[2m✕\x1b[0m");
				}

				const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
				const labelText = isSelected
					? (this.theme?.fg ? this.theme.fg("accent", labelPadded) : `\x1b[36m${labelPadded}\x1b[0m`)
					: labelPadded;

				let descExtra = "";
				if (item.profile === "full") {
					if (!status.isModelCached) {
						descExtra = this.theme?.fg ? ` ${this.theme.fg("warning", "(~147 MB download)")}` : " (~147 MB download)";
					} else {
						descExtra = this.theme?.fg ? ` ${this.theme.fg("success", "(ready)")}` : " (ready)";
					}
				}

				const descStr = `${item.desc}${descExtra}`;
				const descText = this.theme?.fg ? this.theme.fg("dim", descStr) : `\x1b[2m${descStr}\x1b[0m`;

				const lineContent = `${cursor}${indicator}  ${labelText}  ${descText}`;
				lines.push(truncateToWidth(lineContent, width));
			}

			const selected = this.profileItems[this.profileSelectedIndex];
			if (selected) {
				lines.push("");
				let detailText = selected.desc;
				if (selected.id === "auto") {
					detailText = `Auto-detect: selects Lean on machines with < 4 CPUs, or Full on machines with >= 4 CPUs (detected: ${status.hardwareInfo}).`;
				} else if (selected.id === "lean") {
					detailText = "Lean mode: fast AST BM25 lexical keyword search. Uses 0% CPU background overhead and 0 MB extra RAM.";
				} else if (selected.id === "full") {
					detailText = `Full mode: hybrid AST BM25 + 768-dim vector embeddings (Alibaba-NLP/gte-modernbert-base). Model status: ${status.modelStatus}.`;
				} else if (selected.id === "off") {
					detailText = "Disable engine: unloads code search index and embeddings from memory, removing code_search from active tools.";
				} else if (selected.id === "reindex") {
					detailText = "Re-index workspace: clears cached AST chunks and vector embeddings, rescanning all workspace source files.";
				} else if (selected.id === "close") {
					detailText = "Close panel: dismisses this settings dialog without making further changes.";
				}

				const wrapped = wrapTextWithAnsi(detailText, width - 6);
				for (const w of wrapped) {
					lines.push(this.theme?.fg ? `    ${this.theme.fg("dim", w)}` : `    \x1b[2m${w}\x1b[0m`);
				}
			}

			lines.push("");
			const hintText = "  ↑/↓: navigate · Enter/Space: select · Tab: next tab · Esc: close & apply";
			lines.push(this.theme?.fg ? this.theme.fg("dim", hintText) : `\x1b[2m${hintText}\x1b[0m`);
			lines.push(borderColor("─".repeat(Math.max(1, width))));
			return lines;
		}

		// ------------------ RENDER: TAB 2 (FILE INDEX SCOPE) ------------------
		const visibleNodes = this.getVisibleTreeNodes();

		let totalIndexedFiles = 0;
		let totalIndexedChunks = 0;
		for (const root of this.treeRoots) {
			const countActive = (n: ScopeTreeNode) => {
				for (const c of n.children) {
					if (c.isDir) {
						countActive(c);
					} else if (!this.isPathExcluded(c.relPath)) {
						totalIndexedFiles++;
						totalIndexedChunks += c.chunkCount;
					}
				}
			};
			countActive(root);
		}

		const scopeHeader = this.theme?.fg
			? this.theme.fg("accent", this.theme.bold("Workspace Index Scope"))
			: "\x1b[1;36mWorkspace Index Scope\x1b[0m";
		const scopeStats = `${totalIndexedFiles} files selected · ${totalIndexedChunks} chunks indexed`;
		lines.push(`  ${scopeHeader}  ${this.theme?.fg ? this.theme.fg("muted", `(${scopeStats})`) : `(${scopeStats})`}`);
		lines.push("");

		if (visibleNodes.length === 0) {
			lines.push(this.theme?.fg ? this.theme.fg("muted", "  No indexable source code files found in workspace.") : "  No indexable source code files found in workspace.");
		} else {
			if (this.treeCursorIndex >= visibleNodes.length) {
				this.treeCursorIndex = Math.max(0, visibleNodes.length - 1);
			}
			const maxVisibleRows = 10;
			if (this.treeCursorIndex < this.treeScrollOffset) {
				this.treeScrollOffset = this.treeCursorIndex;
			} else if (this.treeCursorIndex >= this.treeScrollOffset + maxVisibleRows) {
				this.treeScrollOffset = Math.max(0, this.treeCursorIndex - maxVisibleRows + 1);
			}

			const visibleSlice = visibleNodes.slice(this.treeScrollOffset, this.treeScrollOffset + maxVisibleRows);

			if (this.treeScrollOffset > 0) {
				lines.push(this.theme?.fg ? this.theme.fg("dim", `    ▲ +${this.treeScrollOffset} more above`) : `    ▲ +${this.treeScrollOffset} more above`);
			}

			for (let i = 0; i < visibleSlice.length; i++) {
				const node = visibleSlice[i];
				const absoluteIndex = this.treeScrollOffset + i;
				const isCursor = absoluteIndex === this.treeCursorIndex;

				const cursor = isCursor
					? (this.theme?.fg ? `  ${this.theme.fg("accent", "→ ")}` : "  \x1b[36m→ \x1b[0m")
					: "    ";

				let checkbox = "□ ";
				if (!node.isDir) {
					const isExcluded = this.isPathExcluded(node.relPath);
					checkbox = isExcluded
						? (this.theme?.fg ? `${this.theme.fg("muted", "□")} ` : "□ ")
						: (this.theme?.fg ? `${this.theme.fg("accent", "■")} ` : "■ ");
				} else {
					const state = this.getFolderSelectionState(node);
					if (state === "all") {
						checkbox = this.theme?.fg ? `${this.theme.fg("accent", "■")} ` : "■ ";
					} else if (state === "some") {
						checkbox = this.theme?.fg ? `${this.theme.fg("warning", "◪")} ` : "◪ ";
					} else {
						checkbox = this.theme?.fg ? `${this.theme.fg("muted", "□")} ` : "□ ";
					}
				}

				const expandGlyph = node.isDir
					? (node.expanded ? "▾ " : "▸ ")
					: "  ";

				const indent = "  ".repeat(node.depth);
				const nameStr = node.isDir ? `${node.name}/` : node.name;
				const labelText = isCursor
					? (this.theme?.fg ? this.theme.fg("accent", nameStr) : `\x1b[36m${nameStr}\x1b[0m`)
					: (node.isDir ? (this.theme?.fg ? this.theme.bold(nameStr) : nameStr) : nameStr);

				let badgeStr = "";
				if (node.isDir) {
					badgeStr = `(${node.chunkCount} chunks · ${node.fileCount} files)`;
				} else {
					badgeStr = `(${node.chunkCount} chunk${node.chunkCount === 1 ? "" : "s"})`;
				}
				const badgeText = this.theme?.fg ? this.theme.fg("dim", badgeStr) : `\x1b[2m${badgeStr}\x1b[0m`;

				const rowLine = `${cursor}${checkbox} ${indent}${expandGlyph}${labelText}  ${badgeText}`;
				lines.push(truncateToWidth(rowLine, width));
			}

			const remainingBelow = visibleNodes.length - (this.treeScrollOffset + visibleSlice.length);
			if (remainingBelow > 0) {
				lines.push(this.theme?.fg ? this.theme.fg("dim", `    ▼ +${remainingBelow} more below`) : `    ▼ +${remainingBelow} more below`);
			}
		}

		const currentNode = visibleNodes[this.treeCursorIndex];
		if (currentNode) {
			lines.push("");
			if (!currentNode.isDir) {
				const isExcluded = this.isPathExcluded(currentNode.relPath);
				const statusTag = isExcluded
					? (this.theme?.fg ? this.theme.fg("warning", "EXCLUDED") : "EXCLUDED")
					: (this.theme?.fg ? this.theme.fg("success", "INDEXED") : "INDEXED");

				const previewTitle = this.theme?.fg
					? this.theme.fg("accent", `Preview: ${currentNode.relPath}`)
					: `Preview: ${currentNode.relPath}`;
				lines.push(`    ${previewTitle}  ${this.theme?.fg ? this.theme.fg("dim", `[${statusTag}]`) : `[${statusTag}]`}`);

				const previewDetail = `Will produce ${currentNode.chunkCount} code chunk(s) (functions, classes, semantic AST blocks)`;
				lines.push(this.theme?.fg ? `    ${this.theme.fg("dim", previewDetail)}` : `    \x1b[2m${previewDetail}\x1b[0m`);
			} else {
				const state = this.getFolderSelectionState(currentNode);
				const stateText = state === "all" ? "ALL INCLUDED" : state === "some" ? "PARTIALLY INCLUDED" : "ALL EXCLUDED";
				const previewTitle = this.theme?.fg
					? this.theme.fg("accent", `Preview Folder: ${currentNode.relPath}/`)
					: `Preview Folder: ${currentNode.relPath}/`;
				lines.push(`    ${previewTitle}  ${this.theme?.fg ? this.theme.fg("dim", `[${stateText}]`) : `[${stateText}]`}`);

				const previewDetail = `Contains ${currentNode.fileCount} code file(s) across this directory tree (${currentNode.chunkCount} total chunks)`;
				lines.push(this.theme?.fg ? `    ${this.theme.fg("dim", previewDetail)}` : `    \x1b[2m${previewDetail}\x1b[0m`);
			}
		}

		lines.push("");
		const hintText = "  ↑/↓: navigate · Space: toggle [x] · Enter/→: expand · Tab: next tab · Esc: close & apply";
		lines.push(this.theme?.fg ? this.theme.fg("dim", hintText) : `\x1b[2m${hintText}\x1b[0m`);
		lines.push(borderColor("─".repeat(Math.max(1, width))));

		return lines;
	}
}

// Backwards-compatible export alias for any legacy callers
export { UnifiedControlModal as SearchControlModal };
