import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getPiHomeDir,
	saveProjectKernelConfig,
	saveGlobalKernelConfig,
	getProjectConfigPath,
	getGlobalRawConfig,
} from "../config";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";
import { parseToml } from "../config/toml";

export type SearchProfile = "lean" | "hybrid" | "full" | "off" | "auto";

export const EMBEDDING_MODEL_ID = "Alibaba-NLP/gte-modernbert-base";
export const EMBEDDING_MODEL_REVISION = "e7f32e3c00f91d699e8c43b53106206bcc72bb22";
/**
 * Minimum query–chunk cosine for a vector hit to enter fusion. Calibrated for gte-modernbert-base on 168 held-out
 * queries: the highest floor that drops no top-5 hit (0.5 dropped 2 right files and 2 right chunks).
 */
export const DENSE_SIMILARITY_FLOOR = 0.45;

export interface SearchConfig {
	profile: SearchProfile;
	/** "hybrid" is accepted as a profile name but resolves to "full": both used the same model at the same cost. */
	effectiveProfile: "lean" | "full" | "off";
	matryoshkaDim: number;
	/** Minimum cosine similarity required before vector results enter RRF. */
	vectorSimilarityThreshold: number;
	numThreads: number;
	modelId: string;
	modelRevision: string;
	dtype: "q8" | "fp32" | "fp16";
	batchSize: number;
	sleepBetweenBatchesMs: number;
	cacheDir: string;
	lazyLoad: boolean;
}

const SETTINGS_FILE = path.join(
	getPiHomeDir(),
	"agent",
	"search_settings.json",
);

/**
 * Auto-detect the best profile based on current hardware.
 * Strictly defaults to "lean" (AST-aware BM25) for ultra-fast, zero-overhead lexical search.
 */
export function detectBestProfile(): "lean" | "full" {
	return os.cpus().length >= 4 ? "full" : "lean";
}

/**
 * Load persisted search settings or default to config.toml setting.
 */
export function loadPersistedProfile(
	cwd?: string,
	projectTrusted = false,
): SearchProfile {
	// 1. Explicit trusted project-local config (.pi/config.toml only)
	const projectPath = cwd && projectTrusted ? getProjectConfigPath(cwd) : null;
	if (projectPath && fs.existsSync(projectPath)) {
		try {
			const raw = parseToml(fs.readFileSync(projectPath, "utf-8"));
			const retrieval = raw.retrieval;
			if (retrieval && typeof retrieval === "object" && !Array.isArray(retrieval)) {
				const p = (retrieval as Record<string, unknown>).default_profile;
				if (typeof p === "string" && ["lean", "hybrid", "full", "off", "auto"].includes(p)) {
					return p as SearchProfile;
				}
			}
		} catch (e) {
			kernelDebug(e);
		}
	}

	// 2. Explicit global configuration (~/.pi/agent/config.toml)
	const globalRaw = getGlobalRawConfig();
	if (
		globalRaw.retrieval?.default_profile &&
		["lean", "hybrid", "full", "off", "auto"].includes(globalRaw.retrieval.default_profile as string)
	) {
		return globalRaw.retrieval.default_profile as SearchProfile;
	}

	// 3. Legacy search_settings.json fallback
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
			if (
				data.profile &&
				["lean", "hybrid", "full", "off", "auto"].includes(data.profile)
			) {
				return data.profile as SearchProfile;
			}
		}
	} catch (e) {
		kernelDebug(e);
	}

	// 4. Canonical hardcoded default fallback
	return "lean";
}

/**
 * Persist search settings to disk and config.toml.
 */
export function savePersistedProfile(profile: SearchProfile, cwd?: string): void {
	try {
		if (cwd) {
			// Workspace-local profile update: writes only to project-local config.toml
			saveProjectKernelConfig(cwd, { retrieval: { default_profile: profile } });
		} else {
			// Global profile update: writes to global ~/.pi/agent/config.toml and legacy search_settings.json
			saveGlobalKernelConfig({ retrieval: { default_profile: profile } });
			const dir = path.dirname(SETTINGS_FILE);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			writeFileSyncAtomic(
				SETTINGS_FILE,
				JSON.stringify({ profile, updatedAt: new Date().toISOString() }, null, 2),
			);
		}
	} catch (e) {
		kernelDebug(e);
	}
}

/**
 * Resolve effective configuration for the given profile.
 * When requestedProfile is not explicitly provided, strictly resolves to BM25 lean mode.
 */
export function getSearchConfig(
	requestedProfile?: SearchProfile,
	cwd?: string,
	projectTrusted = false,
): SearchConfig {
	const profile = requestedProfile || loadPersistedProfile(cwd, projectTrusted);
	const effectiveProfile: "lean" | "full" | "off" =
		profile === "auto" ? detectBestProfile() : profile === "hybrid" ? "full" : profile || "lean";

	const globalCacheDir = path.join(os.homedir(), ".pi", "cache", "search");

	if (effectiveProfile === "off") {
		return {
			profile,
			effectiveProfile: "off",
			matryoshkaDim: 0,
			vectorSimilarityThreshold: 0,
			numThreads: 1,
			modelId: EMBEDDING_MODEL_ID,
			modelRevision: EMBEDDING_MODEL_REVISION,
			dtype: "q8",
			batchSize: 1,
			sleepBetweenBatchesMs: 0,
			cacheDir: globalCacheDir,
			lazyLoad: true,
		};
	}

	// Lean Profile: Pure AST-aware BM25. Zero ONNX loading, zero CPU overhead, <1MB RAM.
	if (effectiveProfile === "lean") {
		return {
			profile,
			effectiveProfile: "lean",
			matryoshkaDim: 0,
			vectorSimilarityThreshold: 0,
			numThreads: 1,
			modelId: EMBEDDING_MODEL_ID,
			modelRevision: EMBEDDING_MODEL_REVISION,
			dtype: "q8",
			batchSize: 1,
			sleepBetweenBatchesMs: 0,
			cacheDir: globalCacheDir,
			lazyLoad: true,
		};
	}

	// Full Profile: BM25 + 768-dim code embeddings, controlled multi-core setting.
	return {
		profile,
		effectiveProfile: "full",
		matryoshkaDim: 768,
		vectorSimilarityThreshold: DENSE_SIMILARITY_FLOOR,
		numThreads: Math.min(2, Math.max(1, Math.floor(os.cpus().length / 2))),
		modelId: EMBEDDING_MODEL_ID,
		modelRevision: EMBEDDING_MODEL_REVISION,
		dtype: "q8",
		// One text per call: with q8 weights, batched texts change each other's vectors.
		batchSize: 1,
		sleepBetweenBatchesMs: 50,
		cacheDir: globalCacheDir,
		lazyLoad: true,
	};
}
