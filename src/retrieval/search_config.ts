import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPiHomeDir, loadKernelConfig } from "../config";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";

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
export function loadPersistedProfile(): SearchProfile {
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
			if (
				data.profile &&
				["lean", "hybrid", "full", "off"].includes(data.profile)
			) {
				return data.profile as SearchProfile;
			}
		}
	} catch (e) {
		kernelDebug(e);
	}
	const kernelCfg = loadKernelConfig();
	return (kernelCfg.retrieval.default_profile as SearchProfile) || "lean";
}

/**
 * Persist search settings to disk.
 */
export function savePersistedProfile(profile: SearchProfile): void {
	try {
		const dir = path.dirname(SETTINGS_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		writeFileSyncAtomic(
			SETTINGS_FILE,
			JSON.stringify({ profile, updatedAt: new Date().toISOString() }, null, 2),
		);
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
): SearchConfig {
	const profile = requestedProfile || loadPersistedProfile();
	const effectiveProfile: "lean" | "hybrid" | "full" | "off" =
		profile === "auto" ? "lean" : profile || "lean";

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
			// Initial conservative floor from the bounded feedback fixture; larger
			// labeled-corpus calibration remains planned.
			vectorSimilarityThreshold: 0.6,
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
		// Use the same initial floor until a larger labeled corpus justifies
		// profile-specific calibration.
		vectorSimilarityThreshold: 0.6,
		numThreads: Math.min(2, Math.max(1, Math.floor(os.cpus().length / 2))),
		modelId: "nomic-ai/nomic-embed-text-v1.5",
		dtype: "q8",
		batchSize: 2,
		sleepBetweenBatchesMs: 50,
		cacheDir: globalCacheDir,
		lazyLoad: true,
	};
}
