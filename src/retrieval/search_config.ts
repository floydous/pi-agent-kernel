import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getPiHomeDir,
	loadKernelConfig,
	saveProjectKernelConfig,
	saveGlobalKernelConfig,
	getProjectConfigPath,
	getGlobalConfigPath,
	getGlobalRawConfig,
} from "../config";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";
import { parseToml } from "../config/toml";

export type SearchProfile = "lean" | "hybrid" | "full" | "off" | "auto";

export interface SearchConfig {
	profile: SearchProfile;
	effectiveProfile: "lean" | "hybrid" | "full" | "off";
	matryoshkaDim: number;
	/** Minimum cosine similarity required before vector results enter RRF. */
	vectorSimilarityThreshold: number;
	numThreads: number;
	modelId: string;
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
export function detectBestProfile(): "lean" | "hybrid" | "full" {
	const cpuCount = os.cpus().length;
	if (cpuCount >= 8) return "full";
	if (cpuCount >= 4) return "hybrid";
	return "lean";
}

/**
 * Load persisted search settings or default to config.toml setting.
 */
export function loadPersistedProfile(cwd?: string): SearchProfile {
	// 1. Explicit project-local config (.pi/config.toml or config.toml)
	const projectPath = cwd ? getProjectConfigPath(cwd) : null;
	if (projectPath && fs.existsSync(projectPath)) {
		try {
			const raw = parseToml(fs.readFileSync(projectPath, "utf-8"));
			const retrieval = raw.retrieval;
			if (retrieval && typeof retrieval === "object" && !Array.isArray(retrieval)) {
				const p = (retrieval as any).default_profile;
				if (p && ["lean", "hybrid", "full", "off", "auto"].includes(p)) {
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
			saveProjectKernelConfig(cwd, { retrieval: { default_profile: profile as any } });
		} else {
			// Global profile update: writes to global ~/.pi/agent/config.toml and legacy search_settings.json
			saveGlobalKernelConfig({ retrieval: { default_profile: profile as any } });
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
): SearchConfig {
	const profile = requestedProfile || loadPersistedProfile(cwd);
	const effectiveProfile: "lean" | "hybrid" | "full" | "off" =
		profile === "auto" ? detectBestProfile() : profile || "lean";

	const globalCacheDir = path.join(os.homedir(), ".pi", "cache", "search");

	if (effectiveProfile === "off") {
		return {
			profile,
			effectiveProfile: "off",
			matryoshkaDim: 0,
			vectorSimilarityThreshold: 0,
			numThreads: 1,
			modelId: "nomic-ai/nomic-embed-text-v1.5",
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
			modelId: "nomic-ai/nomic-embed-text-v1.5",
			dtype: "q8",
			batchSize: 1,
			sleepBetweenBatchesMs: 0,
			cacheDir: globalCacheDir,
			lazyLoad: true,
		};
	}

	// Hybrid Profile: Gentle 1-thread Nomic 256-dim embeddings with throttle sleeps.
	if (effectiveProfile === "hybrid") {
		return {
			profile,
			effectiveProfile: "hybrid",
			matryoshkaDim: 256,
			// Empirically calibrated: 0.55 admits natural-language cross-domain queries
			// while cleanly blocking off-topic noise (unrelated queries score ~0.48-0.52).
			vectorSimilarityThreshold: 0.55,
			numThreads: 1,
			modelId: "nomic-ai/nomic-embed-text-v1.5",
			dtype: "q8",
			batchSize: 1,
			sleepBetweenBatchesMs: 80, // 80ms sleep between chunk batches to prevent CPU starvation
			cacheDir: globalCacheDir,
			lazyLoad: true,
		};
	}

	// Full Profile: Controlled multi-core workstation setting.
	return {
		profile,
		effectiveProfile: "full",
		matryoshkaDim: 768,
		// Empirically calibrated floor for 768-dim embeddings.
		vectorSimilarityThreshold: 0.55,
		numThreads: Math.min(2, Math.max(1, Math.floor(os.cpus().length / 2))),
		modelId: "nomic-ai/nomic-embed-text-v1.5",
		dtype: "q8",
		batchSize: 2,
		sleepBetweenBatchesMs: 50,
		cacheDir: globalCacheDir,
		lazyLoad: true,
	};
}
