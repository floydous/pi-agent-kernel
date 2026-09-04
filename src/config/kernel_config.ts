import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseToml, stringifyToml, type TomlValue } from "./toml";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";

export interface RetrievalConfig {
	default_profile: "lean" | "hybrid" | "full";
	repo_map_budget: number;
	max_search_results: number;
}

export interface SafetyConfig {
	enable_epistemic_guard: boolean;
	max_line_length: number;
	max_lines: number;
	max_total_bytes: number;
	exec_timeout_ms: number;
	/** Don't dedup tool results whose rendered text is <= this many bytes. */
	dedup_min_bytes: number;
	/** LRU cap per session for the dedup side store. */
	dedup_max_entries_per_session: number;
}

export interface KernelConfigOverrides {
	retrieval?: Partial<RetrievalConfig>;
	safety?: Partial<SafetyConfig>;
	lsp?: Partial<LspConfig>;
	ui?: Partial<UiConfig>;
}

export interface LspConfig {
	idle_timeout_ms: number;
	diagnostic_timeout_ms: number;
	init_timeout_ms: number;
	spinner_interval_ms: number;
	disabled_servers: string[];
}

export interface UiConfig {
	enable_pastel_footer: boolean;
}

export interface KernelConfig {
	retrieval: RetrievalConfig;
	safety: SafetyConfig;
	lsp: LspConfig;
	ui: UiConfig;
}

const DEFAULT_CONFIG: KernelConfig = {
	retrieval: {
		default_profile: "hybrid",
		repo_map_budget: 1024,
		max_search_results: 5,
	},
	safety: {
		enable_epistemic_guard: true,
		max_line_length: 300,
		max_lines: 40,
		max_total_bytes: 20 * 1024,
		exec_timeout_ms: 5000,
		dedup_min_bytes: 80,
		dedup_max_entries_per_session: 1024,
	},
	lsp: {
		idle_timeout_ms: 5 * 60 * 1000, // 5 minutes
		diagnostic_timeout_ms: 8000, // 8s for type-checking on large workspaces
		init_timeout_ms: 25000, // 25s for heavy servers like rust-analyzer/vtsls/gopls
		spinner_interval_ms: 80,
		disabled_servers: [],
	},
	ui: {
		enable_pastel_footer: true,
	},
};

/**
 * Resolve ~/.pi root directory
 */
export function getPiHomeDir(): string {
	if (process.env.PI_DIR) return process.env.PI_DIR;
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	return path.join(os.homedir(), ".pi");
}

/**
 * Resolve global configuration file path
 */
export function getGlobalConfigPath(): string {
	const piDir = getPiHomeDir();
	const agentPath = path.join(piDir, "agent", "config.toml");
	if (fs.existsSync(agentPath)) return agentPath;

	const rootPath = path.join(piDir, "config.toml");
	if (fs.existsSync(rootPath)) return rootPath;

	// If PI_CODING_AGENT_DIR was set directly to ~/.pi/agent, check for config.toml right in piDir
	if (path.basename(piDir) === "agent") {
		return rootPath;
	}

	return agentPath;
}

/**
 * Resolve workspace project-local configuration path (.pi/config.toml, agent-kernel/config.toml, or config.toml)
 */
export function getProjectConfigPath(cwd = process.cwd()): string | null {
	let current = path.resolve(cwd);
	const root = path.parse(current).root;

	while (current && current !== root) {
		const candidates = [
			path.join(current, "config.toml"),
			path.join(current, "agent-kernel", "config.toml"),
			path.join(current, ".pi", "config.toml"),
		];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return null;
}

/**
 * Load and merge hierarchical configuration:
 * Defaults -> Global (~/.pi/agent/config.toml) -> Project (.pi/config.toml) -> Environment Variables
 */
export function loadKernelConfig(cwd = process.cwd()): KernelConfig {
	// Deep clone defaults
	const config: KernelConfig = structuredClone(DEFAULT_CONFIG);

	// 1. Merge Global Config if present
	const globalPath = getGlobalConfigPath();
	if (fs.existsSync(globalPath)) {
		try {
			const raw = fs.readFileSync(globalPath, "utf-8");
			const parsed = parseToml(raw);
			mergeDeep(config, parsed);
		} catch (e) {
			kernelDebug(e);
		}
	}

	// 2. Merge Project-Local Config if present
	const projectPath = getProjectConfigPath(cwd);
	if (projectPath && fs.existsSync(projectPath)) {
		try {
			const raw = fs.readFileSync(projectPath, "utf-8");
			const parsed = parseToml(raw);
			mergeDeep(config, parsed);
		} catch (e) {
			kernelDebug(e);
		}
	}

	// 3. Environment Variable Overrides
	if (process.env.PI_REPO_MAP_BUDGET) {
		const b = parseInt(process.env.PI_REPO_MAP_BUDGET, 10);
		if (!isNaN(b)) config.retrieval.repo_map_budget = b;
	}

	if (process.env.PI_RETRIEVAL_PROFILE) {
		const p = process.env.PI_RETRIEVAL_PROFILE.toLowerCase();
		if (p === "lean" || p === "hybrid" || p === "full") {
			config.retrieval.default_profile = p as any;
		}
	}

	return config;
}

/**
 * Save user overrides to global configuration file (~/.pi/agent/config.toml)
 */
export function saveGlobalKernelConfig(updates: KernelConfigOverrides): void {
	const globalPath = getGlobalConfigPath();
	const parentDir = path.dirname(globalPath);
	if (!fs.existsSync(parentDir)) {
		fs.mkdirSync(parentDir, { recursive: true });
	}

	let existing: Record<string, TomlValue> = {};
	if (fs.existsSync(globalPath)) {
		try {
			existing = parseToml(fs.readFileSync(globalPath, "utf-8"));
		} catch (e) {
			kernelDebug(e);
		}
	}

	mergeDeep(existing, updates);
	const tomlString = stringifyToml(existing);
	writeFileSyncAtomic(globalPath, tomlString);
}

function mergeDeep(target: any, source: any) {
	if (!source || typeof source !== "object") return;
	for (const key of Object.keys(source)) {
		const sVal = source[key];
		if (sVal && typeof sVal === "object" && !Array.isArray(sVal)) {
			if (!target[key] || typeof target[key] !== "object") {
				target[key] = {};
			}
			mergeDeep(target[key], sVal);
		} else if (sVal !== undefined) {
			target[key] = sVal;
		}
	}
}
