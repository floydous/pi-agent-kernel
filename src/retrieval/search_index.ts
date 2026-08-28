import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { type CodeChunk, chunkWorkspace, computeHash } from "./search_chunker";
import { BM25Engine } from "./search_bm25";
import { LocalEmbedder } from "./search_embedder";
import {
	getSearchConfig,
	type SearchConfig,
	type SearchProfile,
	savePersistedProfile,
} from "./search_config";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";

export interface SearchHit {
	chunk: CodeChunk;
	rrfScore: number;
	bm25Score: number;
	vectorScore: number;
	bm25Rank?: number;
	vectorRank?: number;
	matches: string[];
}

export class HybridSearchIndex {
	private cwd: string;
	private config: SearchConfig;
	private bm25: BM25Engine = new BM25Engine();
	private embedder: LocalEmbedder;
	private chunks: Map<string, CodeChunk> = new Map();
	private vectors: Map<string, Float32Array> = new Map();
	private fileHashes: Map<string, string> = new Map(); // relPath -> SHA256 hash
	private isInitialized = false;
	private isIndexing = false;

	constructor(cwd: string, profile?: SearchProfile) {
		this.cwd = cwd;
		this.config = getSearchConfig(profile);
		this.embedder = new LocalEmbedder(this.config);
		this.loadFromDisk();
	}

	public getProfile(): SearchProfile {
		return this.config.profile;
	}

	public getEffectiveProfile(): "lean" | "hybrid" | "full" | "off" {
		return this.config.effectiveProfile;
	}

	public setProfile(profile: SearchProfile): void {
		savePersistedProfile(profile);
		this.config = getSearchConfig(profile);
		this.embedder.updateConfig(this.config);
		if (
			this.config.effectiveProfile === "off" ||
			this.config.effectiveProfile === "lean"
		) {
			void this.embedder.dispose();
			this.vectors.clear();
			try {
				if (typeof (global as any).gc === "function") {
					(global as any).gc();
				}
			} catch (e) {
				kernelDebug(e);
			}
		}
	}

	/**
	 * Warm up / preload embedding weights into RAM if profile requires vectors.
	 */
	public async preloadModel(
		onProgress?: (msg: string) => void,
	): Promise<boolean> {
		if (
			this.config.effectiveProfile === "hybrid" ||
			this.config.effectiveProfile === "full"
		) {
			return await this.embedder.initialize(onProgress);
		}
		return false;
	}

	private getCacheDir(): string {
		return path.join(this.cwd, ".pi", "cache", "search");
	}

	private getIndexFilePath(): string {
		return path.join(this.getCacheDir(), "index.json");
	}

	private getVectorsFilePath(): string {
		return path.join(this.getCacheDir(), "vectors.bin");
	}

	/**
	 * Load cached index from disk if available.
	 */
	public loadFromDisk(): boolean {
		const indexPath = this.getIndexFilePath();
		const vectorsPath = this.getVectorsFilePath();

		if (!fs.existsSync(indexPath)) return false;

		try {
			const raw = fs.readFileSync(indexPath, "utf-8");
			const data = JSON.parse(raw);

			if (data.version !== 1) return false;

			this.chunks.clear();
			this.bm25.clear();
			this.fileHashes.clear();
			this.vectors.clear();

			for (const chunk of data.chunks as CodeChunk[]) {
				this.chunks.set(chunk.id, chunk);
				this.bm25.addChunk(chunk);
			}
			this.bm25.recalculateStats();

			for (const [f, h] of Object.entries(data.fileHashes || {})) {
				this.fileHashes.set(f, h as string);
			}

			// Only load binary vectors when metadata proves a complete, one-to-one
			// chunk/vector mapping. Otherwise retain the safe BM25 index only.
			const wantsVectors =
				this.config.effectiveProfile === "hybrid" ||
				this.config.effectiveProfile === "full";
			const vectorChunkIds = data.vectorChunkIds;
			const validVectorMetadata =
				wantsVectors &&
				data.profile === this.config.profile &&
				fs.existsSync(vectorsPath) &&
				Number.isInteger(data.vectorDim) &&
				data.vectorDim > 0 &&
				Array.isArray(vectorChunkIds) &&
				vectorChunkIds.length > 0 &&
				new Set(vectorChunkIds).size === vectorChunkIds.length &&
				vectorChunkIds.every((id: unknown) => typeof id === "string" && this.chunks.has(id));
			if (validVectorMetadata) {
				const buf = fs.readFileSync(vectorsPath);
				const dim = data.vectorDim as number;
				const expectedBytes = vectorChunkIds.length * dim * 4;
				if (
					buf.byteLength === expectedBytes &&
					typeof data.vectorHash === "string" &&
					data.vectorHash ===
						crypto
							.createHash("sha256")
							.update(JSON.stringify(vectorChunkIds))
							.update(buf)
							.digest("hex")
				) {
					const floatArray = new Float32Array(
						buf.buffer,
						buf.byteOffset,
						buf.byteLength / 4,
					);

					for (let index = 0; index < vectorChunkIds.length; index++) {
						const vec = new Float32Array(dim);
						vec.set(floatArray.subarray(index * dim, (index + 1) * dim));
						this.vectors.set(vectorChunkIds[index], vec);
					}
				}
			}

			this.isInitialized = true;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Save current index and binary vectors to disk cache.
	 */
	public saveToDisk(): void {
		try {
			const cacheDir = this.getCacheDir();
			if (!fs.existsSync(cacheDir)) {
				fs.mkdirSync(cacheDir, { recursive: true });
			}

			// Ensure .gitignore exists in .pi/cache
			const gitignorePath = path.join(this.cwd, ".pi", "cache", ".gitignore");
			if (!fs.existsSync(gitignorePath)) {
				try {
					fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf-8");
				} catch (e) {
					kernelDebug(e);
				}
			}

			const chunkList = Array.from(this.chunks.values());
			const fileHashesObj: Record<string, string> = {};
			for (const [f, h] of this.fileHashes.entries()) {
				fileHashesObj[f] = h;
			}

			const vectorChunkIds: string[] = [];
			let vectorDim = 0;
			const vectorArrays: Float32Array[] = [];

			for (const [id, vec] of this.vectors.entries()) {
				vectorChunkIds.push(id);
				vectorArrays.push(vec);
				if (vectorDim === 0) vectorDim = vec.length;
			}

			const vectorBuffer = Buffer.alloc(vectorArrays.length * vectorDim * 4);
			for (let i = 0; i < vectorArrays.length; i++) {
				const bytes = Buffer.from(
					vectorArrays[i].buffer,
					vectorArrays[i].byteOffset,
					vectorArrays[i].byteLength,
				);
				bytes.copy(vectorBuffer, i * vectorDim * 4);
			}
			const vectorHash = crypto
				.createHash("sha256")
				.update(JSON.stringify(vectorChunkIds))
				.update(vectorBuffer)
				.digest("hex");

			const indexData = {
				version: 1,
				updatedAt: new Date().toISOString(),
				profile: this.config.profile,
				vectorDim,
				fileHashes: fileHashesObj,
				chunks: chunkList,
				vectorChunkIds,
				vectorHash,
			};

			writeFileSyncAtomic(
				this.getIndexFilePath(),
				JSON.stringify(indexData, null, 2),
			);

			// Write binary vectors
			if (vectorBuffer.length > 0) {
				writeFileSyncAtomic(this.getVectorsFilePath(), vectorBuffer);
			}
		} catch (err) {
			console.error("[Search Index] Failed saving cache:", err);
		}
	}

	/**
	 * Synchronize and incrementally update workspace index.
	 */
	public async syncWorkspace(
		forceReindex = false,
		onProgress?: (msg: string) => void,
	): Promise<{ chunkCount: number; fileCount: number }> {
		if (this.isIndexing) {
			return { chunkCount: this.chunks.size, fileCount: this.fileHashes.size };
		}

		this.isIndexing = true;
		try {
			if (!this.isInitialized && !forceReindex) {
				this.loadFromDisk();
			}

			onProgress?.("Scanning workspace files...");
			const { chunks: currentChunks } = chunkWorkspace(this.cwd);

			// Map file paths to their current content hash
			const currentFiles = new Map<
				string,
				{ hash: string; chunks: CodeChunk[] }
			>();
			for (const chunk of currentChunks) {
				if (!currentFiles.has(chunk.filePath)) {
					currentFiles.set(chunk.filePath, { hash: "", chunks: [] });
				}
				currentFiles.get(chunk.filePath)!.chunks.push(chunk);
			}

			for (const [relPath, info] of currentFiles.entries()) {
				try {
					const absPath = path.resolve(this.cwd, relPath);
					const content = fs.readFileSync(absPath, "utf-8");
					info.hash = computeHash(content);
				} catch (e) {
					kernelDebug(e);
				}
			}

			// Identify changed, added, or deleted files
			const filesToReindex: string[] = [];
			const filesToDelete: string[] = [];

			for (const [relPath, info] of currentFiles.entries()) {
				const oldHash = this.fileHashes.get(relPath);
				if (forceReindex || !oldHash || oldHash !== info.hash) {
					filesToReindex.push(relPath);
				}
			}

			for (const oldRelPath of this.fileHashes.keys()) {
				if (!currentFiles.has(oldRelPath)) {
					filesToDelete.push(oldRelPath);
				}
			}

			// Handle deletions
			for (const delPath of filesToDelete) {
				this.bm25.removeFile(delPath);
				this.fileHashes.delete(delPath);
				for (const chunkId of Array.from(this.chunks.keys())) {
					if (chunkId.startsWith(`${delPath}:`)) {
						this.chunks.delete(chunkId);
						this.vectors.delete(chunkId);
					}
				}
			}
			if (filesToDelete.length > 0) {
				this.bm25.recalculateStats();
				this.saveToDisk();
			}

			// Handle additions and modifications
			if (filesToReindex.length > 0) {
				const chunksToEmbed: CodeChunk[] = [];

				for (const relPath of filesToReindex) {
					// Clean old chunks for this file
					this.bm25.removeFile(relPath);
					for (const chunkId of Array.from(this.chunks.keys())) {
						if (chunkId.startsWith(`${relPath}:`)) {
							this.chunks.delete(chunkId);
							this.vectors.delete(chunkId);
						}
					}

					const fileInfo = currentFiles.get(relPath);
					if (fileInfo) {
						this.fileHashes.set(relPath, fileInfo.hash);
						for (const chunk of fileInfo.chunks) {
							this.chunks.set(chunk.id, chunk);
							this.bm25.addChunk(chunk);
							chunksToEmbed.push(chunk);
						}
					}
				}

				this.bm25.recalculateStats();

				// Embed new chunks if semantic vector search is enabled (hybrid / full)
				const isVectorEnabled =
					this.config.effectiveProfile === "hybrid" ||
					this.config.effectiveProfile === "full";
				if (isVectorEnabled && chunksToEmbed.length > 0) {
					const batchSize = this.config.batchSize || 2;
					const sleepMs = this.config.sleepBetweenBatchesMs || 50;

					for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
						const batch = chunksToEmbed.slice(i, i + batchSize);
						const texts = batch.map((c) => c.textForEmbedding);
						const processed = Math.min(i + batch.length, chunksToEmbed.length);
						const pct = Math.round((processed / chunksToEmbed.length) * 100);
						onProgress?.(
							`Embedding code chunks: ${pct}% (${processed}/${chunksToEmbed.length})`,
						);
						const vecs = await this.embedder.embedBatch(texts, false, onProgress);

						for (let j = 0; j < batch.length; j++) {
							if (vecs[j]) {
								this.vectors.set(batch[j].id, vecs[j]);
							}
						}

						// Async sleep to yield CPU and prevent freezing system daemons
						if (sleepMs > 0 && i + batchSize < chunksToEmbed.length) {
							await new Promise((r) => setTimeout(r, sleepMs));
						}
					}
				}

				this.saveToDisk();
			}

			this.isInitialized = true;
			return { chunkCount: this.chunks.size, fileCount: this.fileHashes.size };
		} finally {
			this.isIndexing = false;
		}
	}

	/**
	 * Perform Hybrid BM25 + Vector Search with Reciprocal Rank Fusion.
	 * If workspace embedding/indexing is in progress, gracefully falls back to Lean (BM25)
	 * mode to ensure instant, non-blocking retrieval without contention.
	 */
	public async search(
		query: string,
		options: {
			limit?: number;
			filePattern?: string;
			profile?: SearchProfile;
		} = {},
	): Promise<SearchHit[]> {
		if (!this.isInitialized && !this.isIndexing) {
			await this.syncWorkspace(false);
		}

		const limit = options.limit || 5;
		const activeConfig = options.profile
			? getSearchConfig(options.profile)
			: this.config;

		// 1. BM25 Search (Instant AST-tokenized lexical retrieval)
		const bm25Results = this.bm25.search(query, 100);
		const bm25RankMap = new Map<
			string,
			{ rank: number; score: number; matches: string[] }
		>();
		bm25Results.forEach((r, idx) => {
			bm25RankMap.set(r.chunkId, {
				rank: idx + 1,
				score: r.score,
				matches: r.matches,
			});
		});

		// 2. Vector Search (if active profile is hybrid/full AND indexing is not actively in progress)
		const vectorRankMap = new Map<string, { rank: number; score: number }>();
		const wantsVectors =
			activeConfig.effectiveProfile === "hybrid" ||
			activeConfig.effectiveProfile === "full";
		const isVectorReady =
			wantsVectors && !this.isIndexing && this.vectors.size > 0;

		if (isVectorReady) {
			const queryVec = await this.embedder.embed(query, true);
			if (queryVec) {
				const vecScores: { chunkId: string; score: number }[] = [];
				for (const [chunkId, vec] of this.vectors.entries()) {
					const score = LocalEmbedder.cosineSimilarity(queryVec, vec);
					vecScores.push({ chunkId, score });
				}

				vecScores.sort((a, b) => b.score - a.score);
				vecScores.slice(0, 100).forEach((item, idx) => {
					vectorRankMap.set(item.chunkId, { rank: idx + 1, score: item.score });
				});
			}
		}

		// 3. Reciprocal Rank Fusion (RRF)
		const k = 60;
		const candidateIds = new Set([
			...bm25RankMap.keys(),
			...vectorRankMap.keys(),
		]);
		const hits: SearchHit[] = [];

		for (const chunkId of candidateIds) {
			const chunk = this.chunks.get(chunkId);
			if (!chunk) continue;

			if (
				options.filePattern &&
				!chunk.filePath.toLowerCase().includes(options.filePattern.toLowerCase())
			) {
				continue;
			}

			const bmData = bm25RankMap.get(chunkId);
			const vecData = vectorRankMap.get(chunkId);

			const bm25Rank = bmData ? bmData.rank : 999;
			const vecRank = vecData ? vecData.rank : 999;

			const rrfBm25 = bmData ? 1 / (k + bm25Rank) : 0;
			const rrfVec = vecData ? 1 / (k + vecRank) : 0;
			const rrfScore = rrfBm25 + rrfVec;

			hits.push({
				chunk,
				rrfScore,
				bm25Score: bmData ? bmData.score : 0,
				vectorScore: vecData ? vecData.score : 0,
				bm25Rank: bmData?.rank,
				vectorRank: vecData?.rank,
				matches: bmData?.matches || [],
			});
		}

		// Sort by combined RRF score descending
		hits.sort((a, b) => b.rrfScore - a.rrfScore);
		return hits.slice(0, limit);
	}

	/**
	 * Get active index diagnostic status.
	 */
	public getStatus(): {
		profile: SearchProfile;
		effectiveProfile: "lean" | "hybrid" | "full" | "off";
		fileCount: number;
		chunkCount: number;
		vectorCount: number;
		isModelLoaded: boolean;
		isModelCached: boolean;
		rssMemoryMB: number;
		modelStatus: string;
		engineState: string;
		pipelineDesc: string;
		hardwareInfo: string;
	} {
		const isModelLoaded = this.embedder.isLoaded();
		const isModelCached = this.embedder.isCachedOnDisk();
		let modelStatus = "";
		let pipelineDesc = "";

		if (this.config.effectiveProfile === "off") {
			modelStatus = "Disabled";
			pipelineDesc = "Engine is turned off";
		} else if (this.config.effectiveProfile === "lean") {
			modelStatus = "Active (BM25 Engine - 0 MB Model RAM)";
			pipelineDesc = "AST-tokenized BM25 Lexical Retrieval";
		} else if (this.config.effectiveProfile === "hybrid") {
			if (isModelLoaded) {
				modelStatus = "Active in RAM (Nomic v1.5 Matryoshka 256-dim)";
			} else if (isModelCached) {
				modelStatus = "Cached on disk (Loads on-demand into RAM)";
			} else {
				modelStatus = "Not downloaded (~135 MB)";
			}
			pipelineDesc = "Hybrid BM25 + 256-dim Matryoshka Vector Search";
		} else {
			if (isModelLoaded) {
				modelStatus = "Active in RAM (Nomic v1.5 768-dim)";
			} else if (isModelCached) {
				modelStatus = "Cached on disk (Loads on-demand into RAM)";
			} else {
				modelStatus = "Not downloaded (~135 MB)";
			}
			pipelineDesc = "Full BM25 + 768-dim Semantic Vector Search";
		}

		let engineState = "Active & Ready";
		if (this.config.effectiveProfile === "off") {
			engineState = "Disabled";
		} else if (this.isIndexing) {
			engineState = "Indexing files...";
		} else if (!this.isInitialized && this.chunks.size === 0) {
			engineState = "Ready (Empty workspace)";
		}

		const cpus = os.cpus().length;
		const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
		const hardwareInfo = `${cpus} CPUs, ${freeMem} GB free RAM`;

		return {
			profile: this.config.profile,
			effectiveProfile: this.config.effectiveProfile,
			fileCount: this.fileHashes.size,
			chunkCount: this.chunks.size,
			vectorCount: this.vectors.size,
			isModelLoaded,
			isModelCached,
			rssMemoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
			modelStatus,
			engineState,
			pipelineDesc,
			hardwareInfo,
		};
	}

	/**
	 * Unload model from RAM.
	 */
	public unloadModel(): void {
		this.embedder.dispose();
	}
}
