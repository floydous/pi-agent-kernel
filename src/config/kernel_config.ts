import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseToml, stringifyToml, type TomlValue } from "./toml";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";

export interface RetrievalConfig {
	default_profile: "auto" | "lean" | "hybrid" | "full" | "off";
	max_search_results: number;
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
	syntax_gate?: "warn" | "block";
}

export interface KernelConfigOverrides {
	retrieval?: Partial<RetrievalConfig>;
	safety?: Partial<SafetyConfig>;
	editing?: Partial<EditingConfig>;
	ui?: Partial<UiConfig>;
	instructions?: Partial<InstructionsConfig>;
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
	ui: UiConfig;
	instructions: InstructionsConfig;
}

const DEFAULT_CONFIG: KernelConfig = {
	retrieval: {
		default_profile: "lean",
		max_search_results: 5,
	},
	safety: {
		enable_epistemic_guard: true,
		max_line_length: 300,
		max_lines: 100,
		max_total_bytes: 20 * 1024,
		exec_timeout_ms: 5000,
	},
	editing: {
		mode: "smart_anchor",
		default_anchors: false,
		read_mode: "plain",
		syntax_gate: "warn",
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
		"max_search_results",
	]),
	safety: new Set([
		"enable_epistemic_guard",
		"max_line_length",
		"max_lines",
		"max_total_bytes",
		"exec_timeout_ms",
	]),
	editing: new Set(["mode", "default_anchors", "read_mode", "syntax_gate"]),
	ui: new Set(["enable_pastel_footer"]),
	instructions: new Set(["enabled", "pi_docs"]),
};

const DEPRECATED_RETRIEVAL_KEYS = new Set([
	"enable_tools",
	"repo_map_budget",
	"repo_map_min_files",
	"repo_map_min_bytes",
]);

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
	requireSafeInt(retrieval.max_search_results, "retrieval.max_search_results", 1, 15);

	const safety = config.safety;
	requireBoolean(safety.enable_epistemic_guard, "safety.enable_epistemic_guard");
	requireSafeInt(safety.max_line_length, "safety.max_line_length", 20, 10_000);
	requireSafeInt(safety.max_lines, "safety.max_lines", 1, 10_000);
	requireSafeInt(safety.max_total_bytes, "safety.max_total_bytes", 64, 10 * 1024 * 1024);
	requireSafeInt(safety.exec_timeout_ms, "safety.exec_timeout_ms", 100, 120_000);

	requireEnum(config.editing.mode, "editing.mode", ["smart_anchor", "standard"]);
	requireBoolean(config.editing.default_anchors, "editing.default_anchors");
	requireEnum(config.editing.read_mode, "editing.read_mode", ["auto", "plain", "anchored"]);
	if (config.editing.syntax_gate !== undefined) {
		requireEnum(config.editing.syntax_gate, "editing.syntax_gate", ["warn", "block"]);
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
	const sanitizedSource: Record<string, unknown> = {};
	for (const [section, value] of Object.entries(source as Record<string, unknown>)) {
		if (section === "lsp") continue; // Deprecated legacy section: accepted and ignored
		if (!ALLOWED_CONFIG_KEYS[section as keyof KernelConfig]) {
			throw new KernelConfigError(`Unknown configuration section: ${section}`);
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new KernelConfigError(`${section} must be a table`);
		}
		const sectionObj: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			if (section === "retrieval" && DEPRECATED_RETRIEVAL_KEYS.has(key)) continue; // Deprecated legacy setting: accepted and ignored
			if (!ALLOWED_CONFIG_KEYS[section as keyof KernelConfig].has(key)) {
				throw new KernelConfigError(`Unknown configuration key: ${configPath([section, key])}`);
			}
			sectionObj[key] = val;
		}
		sanitizedSource[section] = sectionObj;
	}
	mergeDeep(candidate, sanitizedSource);
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
	if (process.env.PI_RETRIEVAL_PROFILE) {
		const p = process.env.PI_RETRIEVAL_PROFILE.toLowerCase();
		if (p === "lean" || p === "hybrid" || p === "full") {
			config.retrieval.default_profile = p;
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
		const existing = parseToml(fs.readFileSync(globalPath, "utf-8"));
		const sec = existing[section];
		if (sec && typeof sec === "object" && !Array.isArray(sec) && (sec as Record<string, TomlValue>)[key] !== undefined) {
			delete (sec as Record<string, TomlValue>)[key];
			if (Object.keys(sec).length === 0) {
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
export function getGlobalRawConfig(): Record<string, Record<string, TomlValue>> {
	const globalPath = getGlobalConfigPath();
	if (fs.existsSync(globalPath)) {
		try {
			const parsed = parseToml(fs.readFileSync(globalPath, "utf-8"));
			const result: Record<string, Record<string, TomlValue>> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (value && typeof value === "object" && !Array.isArray(value)) {
					result[key] = value as Record<string, TomlValue>;
				}
			}
			return result;
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
