import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseToml, stringifyToml, type TomlValue } from "./toml";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";

export interface RetrievalConfig {
	default_profile: "auto" | "lean" | "hybrid" | "full" | "off";
	repo_map_budget: number;
	repo_map_min_files: number;
	repo_map_min_bytes: number;
	max_search_results: number;
	enable_tools?: boolean;
}

export interface SafetyConfig {
	enable_epistemic_guard: boolean;
	max_line_length: number;
	max_lines: number;
	max_total_bytes: number;
	exec_timeout_ms: number;
}

export interface EditingConfig {
	mode: "smart_anchor" | "standard";
	default_anchors: boolean;
	read_mode: "auto" | "plain" | "anchored";
}

export interface KernelConfigOverrides {
	retrieval?: Partial<RetrievalConfig>;
	safety?: Partial<SafetyConfig>;
	editing?: Partial<EditingConfig>;
	lsp?: Partial<LspConfig>;
	ui?: Partial<UiConfig>;
	instructions?: Partial<InstructionsConfig>;
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

export interface InstructionsConfig {
	enabled: boolean;
	pi_docs: boolean;
}

export interface KernelConfig {
	retrieval: RetrievalConfig;
	safety: SafetyConfig;
	editing: EditingConfig;
	lsp: LspConfig;
	ui: UiConfig;
	instructions: InstructionsConfig;
}

const DEFAULT_CONFIG: KernelConfig = {
	retrieval: {
		default_profile: "lean",
		repo_map_budget: 1024,
		repo_map_min_files: 10,
		repo_map_min_bytes: 50 * 1024,
		max_search_results: 5,
		enable_tools: false,
	},
	safety: {
		enable_epistemic_guard: true,
		max_line_length: 300,
		max_lines: 40,
		max_total_bytes: 20 * 1024,
		exec_timeout_ms: 5000,
	},
	editing: {
		mode: "smart_anchor",
		default_anchors: false,
		read_mode: "plain",
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
	instructions: {
		enabled: true,
		pi_docs: true,
	},
};

export class KernelConfigError extends Error {}

const ALLOWED_CONFIG_KEYS: Record<keyof KernelConfig, ReadonlySet<string>> = {
	retrieval: new Set([
		"default_profile",
		"repo_map_budget",
		"repo_map_min_files",
		"repo_map_min_bytes",
		"max_search_results",
		"enable_tools",
	]),
	safety: new Set([
		"enable_epistemic_guard",
		"max_line_length",
		"max_lines",
		"max_total_bytes",
		"exec_timeout_ms",
	]),
	editing: new Set(["mode", "default_anchors", "read_mode"]),
	lsp: new Set([
		"idle_timeout_ms",
		"diagnostic_timeout_ms",
		"init_timeout_ms",
		"spinner_interval_ms",
		"disabled_servers",
	]),
	ui: new Set(["enable_pastel_footer"]),
	instructions: new Set(["enabled", "pi_docs"]),
};

function configPath(parts: string[]): string {
	return parts.join(".");
}

function requireBoolean(value: unknown, path: string): void {
	if (typeof value !== "boolean") throw new KernelConfigError(`${path} must be a boolean`);
}

function requireSafeInt(value: unknown, path: string, min: number, max: number): void {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new KernelConfigError(`${path} must be a safe integer between ${min} and ${max}`);
	}
}

function requireEnum<T extends string>(value: unknown, path: string, values: readonly T[]): void {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new KernelConfigError(`${path} must be one of: ${values.join(", ")}`);
	}
}

export function validateKernelConfig(config: KernelConfig): KernelConfig {
	for (const section of Object.keys(config) as Array<keyof KernelConfig>) {
		const value = (config as any)[section];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new KernelConfigError(`${section} must be a table`);
		}
		for (const key of Object.keys(value)) {
			if (!ALLOWED_CONFIG_KEYS[section].has(key)) {
				throw new KernelConfigError(`Unknown configuration key: ${configPath([section, key])}`);
			}
		}
	}

	const retrieval = config.retrieval;
	requireEnum(retrieval.default_profile, "retrieval.default_profile", ["auto", "lean", "hybrid", "full", "off"]);
	requireSafeInt(retrieval.repo_map_budget, "retrieval.repo_map_budget", 64, 32_768);
	requireSafeInt(retrieval.repo_map_min_files, "retrieval.repo_map_min_files", 0, 10_000);
	requireSafeInt(retrieval.repo_map_min_bytes, "retrieval.repo_map_min_bytes", 0, 1024 * 1024 * 1024);
	requireSafeInt(retrieval.max_search_results, "retrieval.max_search_results", 1, 15);
	requireBoolean(retrieval.enable_tools, "retrieval.enable_tools");

	const safety = config.safety;
	requireBoolean(safety.enable_epistemic_guard, "safety.enable_epistemic_guard");
	requireSafeInt(safety.max_line_length, "safety.max_line_length", 20, 10_000);
	requireSafeInt(safety.max_lines, "safety.max_lines", 1, 10_000);
	requireSafeInt(safety.max_total_bytes, "safety.max_total_bytes", 64, 10 * 1024 * 1024);
	requireSafeInt(safety.exec_timeout_ms, "safety.exec_timeout_ms", 100, 120_000);

	requireEnum(config.editing.mode, "editing.mode", ["smart_anchor", "standard"]);
	requireBoolean(config.editing.default_anchors, "editing.default_anchors");
	requireEnum(config.editing.read_mode, "editing.read_mode", ["auto", "plain", "anchored"]);

	requireSafeInt(config.lsp.idle_timeout_ms, "lsp.idle_timeout_ms", 1_000, 60 * 60 * 1_000);
	requireSafeInt(config.lsp.diagnostic_timeout_ms, "lsp.diagnostic_timeout_ms", 100, 120_000);
	requireSafeInt(config.lsp.init_timeout_ms, "lsp.init_timeout_ms", 100, 5 * 60 * 1_000);
	requireSafeInt(config.lsp.spinner_interval_ms, "lsp.spinner_interval_ms", 16, 1_000);
	if (
		!Array.isArray(config.lsp.disabled_servers) ||
		config.lsp.disabled_servers.length > 64 ||
		config.lsp.disabled_servers.some(
			(server) => typeof server !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(server),
		)
	) {
		throw new KernelConfigError("lsp.disabled_servers must be an array of up to 64 safe server keys");
	}

	requireBoolean(config.ui.enable_pastel_footer, "ui.enable_pastel_footer");
	requireBoolean(config.instructions.enabled, "instructions.enabled");
	requireBoolean(config.instructions.pi_docs, "instructions.pi_docs");
	return config;
}

export function mergeKernelConfig(target: KernelConfig, source: unknown): KernelConfig {
	const candidate = structuredClone(target);
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		throw new KernelConfigError("Configuration root must be a table");
	}
	for (const [section, value] of Object.entries(source as Record<string, unknown>)) {
		if (!ALLOWED_CONFIG_KEYS[section as keyof KernelConfig]) {
			throw new KernelConfigError(`Unknown configuration section: ${section}`);
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new KernelConfigError(`${section} must be a table`);
		}
		for (const key of Object.keys(value as Record<string, unknown>)) {
			if (!ALLOWED_CONFIG_KEYS[section as keyof KernelConfig].has(key)) {
				throw new KernelConfigError(`Unknown configuration key: ${configPath([section, key])}`);
			}
		}
	}
	mergeDeep(candidate, source);
	validateKernelConfig(candidate);
	for (const key of Object.keys(target) as Array<keyof KernelConfig>) {
		delete (target as any)[key];
	}
	Object.assign(target, candidate);
	return target;
}

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
 * Resolve workspace project-local configuration path (.pi/config.toml only).
 * Generic root config.toml and agent-kernel/config.toml are intentionally ignored.
 */
export function getProjectConfigPath(cwd = process.cwd()): string | null {
	let current = path.resolve(cwd);
	const root = path.parse(current).root;

	while (current && current !== root) {
		const candidates = [path.join(current, ".pi", "config.toml")];
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
export function loadKernelConfig(
	cwd = process.cwd(),
	options: { projectTrusted?: boolean } = {},
): KernelConfig {
	// Deep clone defaults
	const config: KernelConfig = structuredClone(DEFAULT_CONFIG);

	// 1. Merge Global Config if present
	const globalPath = getGlobalConfigPath();
	if (fs.existsSync(globalPath)) {
		try {
			const raw = fs.readFileSync(globalPath, "utf-8");
			const parsed = parseToml(raw);
			mergeKernelConfig(config, parsed);
		} catch (e) {
			kernelDebug(e);
		}
	}

	// 2. Merge Project-Local Config if present
	const projectPath = options.projectTrusted === true
		? getProjectConfigPath(cwd)
		: null;
	if (projectPath && fs.existsSync(projectPath)) {
		try {
			const raw = fs.readFileSync(projectPath, "utf-8");
			const parsed = parseToml(raw);
			mergeKernelConfig(config, parsed);
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

	return validateKernelConfig(config);
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

	const existing: Record<string, TomlValue> = fs.existsSync(globalPath)
		? parseToml(fs.readFileSync(globalPath, "utf-8"))
		: {};
	validateConfigDocument(existing);
	validateConfigDocument({ ...existing, ...updates });
	mergeDeep(existing, updates);
	const tomlString = stringifyToml(existing);
	writeFileSyncAtomic(globalPath, tomlString);
}

/**
 * Remove a single setting key from global configuration file (~/.pi/agent/config.toml)
 */
export function removeGlobalKernelConfigKey(section: string, key: string): void {
	const globalPath = getGlobalConfigPath();
	if (!fs.existsSync(globalPath)) return;

	try {
		const existing: any = parseToml(fs.readFileSync(globalPath, "utf-8"));
		if (existing && existing[section] && existing[section][key] !== undefined) {
			delete existing[section][key];
			if (Object.keys(existing[section]).length === 0) {
				delete existing[section];
			}
			validateConfigDocument(existing);
			const tomlString = stringifyToml(existing);
			writeFileSyncAtomic(globalPath, tomlString);
		}
	} catch (e) {
		kernelDebug(e);
	}
}

/**
 * Read raw global configuration TOML if it exists
 */
export function getGlobalRawConfig(): Record<string, any> {
	const globalPath = getGlobalConfigPath();
	if (fs.existsSync(globalPath)) {
		try {
			return parseToml(fs.readFileSync(globalPath, "utf-8")) as any;
		} catch (e) {
			kernelDebug(e);
		}
	}
	return {};
}

/**
 * Determine the target path for saving project-local configuration
 */
export function getTargetProjectConfigPath(cwd = process.cwd()): string {
	const existing = getProjectConfigPath(cwd);
	if (existing) return existing;
	return path.join(path.resolve(cwd), ".pi", "config.toml");
}

export function removeProjectKernelConfigKey(cwd: string, section: string, key: string): void {
	const projectPath = getTargetProjectConfigPath(cwd);
	if (!fs.existsSync(projectPath)) return;
	const existing = parseToml(fs.readFileSync(projectPath, "utf-8"));
	const table = existing[section];
	if (!table || typeof table !== "object" || Array.isArray(table) || !(key in table)) return;
	delete (table as Record<string, TomlValue>)[key];
	if (Object.keys(table).length === 0) delete existing[section];
	validateConfigDocument(existing);
	writeFileSyncAtomic(projectPath, stringifyToml(existing));
}

/**
 * Save user overrides to project-local configuration file (.pi/config.toml)
 */
export function saveProjectKernelConfig(cwd: string, updates: KernelConfigOverrides): string {
	const projectPath = getTargetProjectConfigPath(cwd);
	const parentDir = path.dirname(projectPath);
	if (!fs.existsSync(parentDir)) {
		fs.mkdirSync(parentDir, { recursive: true });
	}

	const existing: Record<string, TomlValue> = fs.existsSync(projectPath)
		? parseToml(fs.readFileSync(projectPath, "utf-8"))
		: {};
	validateConfigDocument(existing);
	validateConfigDocument({ ...existing, ...updates });
	mergeDeep(existing, updates);
	const tomlString = stringifyToml(existing);
	writeFileSyncAtomic(projectPath, tomlString);
	return projectPath;
}

export function validateConfigDocument(source: unknown): KernelConfig {
	return mergeKernelConfig(structuredClone(DEFAULT_CONFIG), source);
}

export function mergeDeep(target: any, source: any) {
	if (!source || typeof source !== "object") return;
	for (const key of Object.keys(source)) {
		if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
		if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
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
