import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
	type CodeChunk,
	chunkFile,
	computeHash,
	findChunkableFiles,
	isProseFilePath,
} from "./search_chunker";
import { BM25Engine } from "./search_bm25";
import { LocalEmbedder } from "./search_embedder";
import {
	getSearchConfig,
	type SearchConfig,
	type SearchProfile,
} from "./search_config";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";
import { TreeSitterEngine } from "./tree_sitter_engine";

const INDEX_VERSION = 3;
const EXTRACTOR_GENERATION = "tree-sitter-wasm-v2";

interface PersistedVectorCache {
	vectorDim: number;
	vectorChunkIds: string[];
	vectorChunkHashes?: string[];
	vectorHash: string;
	fileName: string;
}

export interface SearchHit {
	chunk: CodeChunk;
	rrfScore: number;
	bm25Score: number;
	vectorScore: number;
	signal: "lexical" | "semantic" | "hybrid";
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
	private ignoreConfigHashes: Map<string, string> = new Map(); // ignore config file -> SHA256 hash
	private isInitialized = false;
	private isIndexing = false;
	private dirtyFiles = new Set<string>();
	private generation = 0;
	private fileGenerations = new Map<string, number>();
	private activeFileUpdates = new Map<string, Promise<void>>();
	private debouncedSaveTimer: NodeJS.Timeout | null = null;
	private debouncedSaveDeadline: number | null = null;
	private isSaving = false;
	private hasPendingSave = false;
	private isShuttingDown = false;
	private activeSavePromise: Promise<void> | null = null;
	private activeSync: Promise<{ chunkCount: number; fileCount: number; indexedCount: number }> | null = null;
	private liveCheckPromise: Promise<boolean> | null = null;
	private persistedVectorCaches: PersistedVectorCache[] = [];

	constructor(cwd: string, profile?: SearchProfile) {
		this.cwd = cwd;
		this.config = getSearchConfig(profile, cwd);
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
		const oldEffective = this.config.effectiveProfile;
		this.config = getSearchConfig(profile, this.cwd);
		this.embedder.updateConfig(this.config);

		if (oldEffective !== this.config.effectiveProfile) {
			// Keep vector caches on disk; only the active in-memory representation
			// changes when switching profiles.
			this.vectors.clear();
			this.isInitialized = false;
			this.loadFromDisk();
		}

		if (
			this.config.effectiveProfile === "off" ||
			this.config.effectiveProfile === "lean"
		) {
			void this.embedder.dispose();
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

	private getVectorsFilePath(fileName = "vectors.bin"): string {
		return path.join(this.getCacheDir(), fileName);
	}

	private getVectorCacheFileName(dim: number): string {
		return `vectors-${dim}d.bin`;
	}

	private getPersistedVectorCaches(data: any): PersistedVectorCache[] {
		if (Array.isArray(data.vectorCaches)) {
			return data.vectorCaches.filter(
				(cache: any): cache is PersistedVectorCache =>
					cache &&
					Number.isInteger(cache.vectorDim) &&
					cache.vectorDim > 0 &&
					Array.isArray(cache.vectorChunkIds) &&
					typeof cache.vectorHash === "string" &&
					typeof cache.fileName === "string" &&
					path.basename(cache.fileName) === cache.fileName,
			);
		}

		if (
			Number.isInteger(data.vectorDim) &&
			data.vectorDim > 0 &&
			Array.isArray(data.vectorChunkIds) &&
			typeof data.vectorHash === "string"
		) {
			return [{
				vectorDim: data.vectorDim,
				vectorChunkIds: data.vectorChunkIds,
				vectorChunkHashes: data.vectorChunkHashes,
				vectorHash: data.vectorHash,
				fileName: "vectors.bin",
			}];
		}

		return [];
	}

	private getChunkHashMap(): Map<string, string> {
		return new Map(
			Array.from(this.chunks.values()).map((chunk) => [chunk.id, chunk.hash]),
		);
	}

	private loadVectorCache(cache: PersistedVectorCache): void {
		const vectorChunkIds = cache.vectorChunkIds;
		const vectorPath = this.getVectorsFilePath(cache.fileName);
		if (
			!fs.existsSync(vectorPath) ||
			vectorChunkIds.length === 0 ||
			new Set(vectorChunkIds).size !== vectorChunkIds.length
		) return;

		const buffer = fs.readFileSync(vectorPath);
		const expectedBytes = vectorChunkIds.length * cache.vectorDim * 4;
		if (
			buffer.byteLength !== expectedBytes ||
			cache.vectorHash !==
				crypto
					.createHash("sha256")
					.update(JSON.stringify(vectorChunkIds))
					.update(buffer)
					.digest("hex")
		) return;

		const currentHashes = this.getChunkHashMap();
		const hasChunkHashes =
			Array.isArray(cache.vectorChunkHashes) &&
			cache.vectorChunkHashes.length === vectorChunkIds.length;
		if (Array.isArray(cache.vectorChunkHashes) && !hasChunkHashes) return;
		if (!hasChunkHashes && !this.isWorkspaceSnapshotFresh()) return;
		if (
			!hasChunkHashes &&
			(vectorChunkIds.length !== this.chunks.size ||
				vectorChunkIds.some((id) => !this.chunks.has(id)))
		) return;

		const floatArray = new Float32Array(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength / 4,
		);
		for (let index = 0; index < vectorChunkIds.length; index++) {
			const chunkId = vectorChunkIds[index];
			if (!this.chunks.has(chunkId)) continue;
			if (
				hasChunkHashes &&
				cache.vectorChunkHashes?.[index] !== currentHashes.get(chunkId)
			) continue;
			const vector = new Float32Array(cache.vectorDim);
			vector.set(
				floatArray.subarray(
					index * cache.vectorDim,
					(index + 1) * cache.vectorDim,
				),
			);
			this.vectors.set(chunkId, vector);
		}
	}

	/**
	 * Load cached index from disk if available.
	 */
	public loadFromDisk(): boolean {
		const indexPath = this.getIndexFilePath();

		if (!fs.existsSync(indexPath)) return false;

		try {
			const raw = fs.readFileSync(indexPath, "utf-8");
			const data = JSON.parse(raw);

			if (
				data.version !== INDEX_VERSION ||
				data.extractorGeneration !== EXTRACTOR_GENERATION
			) {
				return false;
			}

			this.chunks.clear();
			this.bm25.clear();
			this.fileHashes.clear();
			this.vectors.clear();
			this.persistedVectorCaches = [];

			for (const chunk of data.chunks as CodeChunk[]) {
				// Normalize chunk.filePath alias if chunk was serialized with file
				if (!chunk.filePath && (chunk as any).file) {
					chunk.filePath = (chunk as any).file;
				}
				// Rebase absolutePath to the current workspace root if paths differ
				if (chunk.filePath && this.cwd) {
					chunk.absolutePath = path.resolve(this.cwd, chunk.filePath);
				}
				this.chunks.set(chunk.id, chunk);
				this.bm25.addChunk(chunk);
			}
			this.bm25.recalculateStats();

			for (const [f, h] of Object.entries(data.fileHashes || {})) {
				this.fileHashes.set(f, h as string);
			}

			this.ignoreConfigHashes.clear();
			if (data.ignoreConfigHashes && typeof data.ignoreConfigHashes === "object") {
				for (const [f, h] of Object.entries(data.ignoreConfigHashes)) {
					if (typeof h === "string") {
						this.ignoreConfigHashes.set(f, h);
					}
				}
			}

			this.persistedVectorCaches = this.getPersistedVectorCaches(data);
			const wantsVectors =
				this.config.effectiveProfile === "hybrid" ||
				this.config.effectiveProfile === "full";
			const activeCache = this.persistedVectorCaches.find(
				(cache) => cache.vectorDim === this.config.matryoshkaDim,
			);
			if (wantsVectors && activeCache) {
				this.loadVectorCache(activeCache);
			}

			const vectorsReady =
				!wantsVectors ||
				(this.vectors.size === this.chunks.size &&
					this.vectors.size > 0 &&
					Array.from(this.vectors.values()).every(
						(vector) => vector.length === this.config.matryoshkaDim,
					));
			this.isInitialized = vectorsReady;
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

			const vectorCaches = new Map<number, PersistedVectorCache>();
			for (const cache of this.persistedVectorCaches) {
				vectorCaches.set(cache.vectorDim, cache);
			}

			if (
				this.vectors.size > 0 &&
				this.vectors.size === this.chunks.size &&
				Array.from(this.vectors.keys()).every((id) => this.chunks.has(id))
			) {
				const vectorChunkIds = Array.from(this.vectors.keys());
				const vectorArrays = vectorChunkIds.map((id) => this.vectors.get(id)!);
				const vectorDim = vectorArrays[0].length;
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
				const vectorChunkHashes = vectorChunkIds.map(
					(id) => this.chunks.get(id)?.hash || "",
				);
				const fileName = this.getVectorCacheFileName(vectorDim);
				vectorCaches.set(vectorDim, {
					vectorDim,
					vectorChunkIds,
					vectorChunkHashes,
					vectorHash,
					fileName,
				});
				writeFileSyncAtomic(this.getVectorsFilePath(fileName), vectorBuffer);
			}

			this.persistedVectorCaches = Array.from(vectorCaches.values());
			const indexData = {
				version: INDEX_VERSION,
				extractorGeneration: EXTRACTOR_GENERATION,
				updatedAt: new Date().toISOString(),
				profile: this.config.profile,
				fileHashes: fileHashesObj,
				ignoreConfigHashes: Object.fromEntries(this.ignoreConfigHashes),
				chunks: chunkList,
				vectorCaches: this.persistedVectorCaches,
			};

			writeFileSyncAtomic(
				this.getIndexFilePath(),
				JSON.stringify(indexData, null, 2),
			);
		} catch (err) {
			console.error("[Search Index] Failed saving cache:", err);
		}
	}

	/**
	 * Schedule debounced disk persistence to coalesce rapid edits.
	 */
	public scheduleDebouncedSave(delayMs = 500, maxDelayMs = 2000): void {
		const now = Date.now();
		if (!this.debouncedSaveDeadline) {
			this.debouncedSaveDeadline = now + maxDelayMs;
		}

		if (this.debouncedSaveTimer) {
			clearTimeout(this.debouncedSaveTimer);
			this.debouncedSaveTimer = null;
		}

		const remainingMax = Math.max(0, this.debouncedSaveDeadline - now);
		const actualDelay = Math.min(delayMs, remainingMax);

		this.debouncedSaveTimer = setTimeout(() => {
			this.debouncedSaveTimer = null;
			this.debouncedSaveDeadline = null;
			void this.flushPendingSave();
		}, actualDelay);
	}

	/**
	 * Flush any pending index updates to disk cache.
	 */
	public async flushPendingSave(isFinalShutdown = false): Promise<void> {
		if (isFinalShutdown) {
			this.isShuttingDown = true;
		}

		// Disarm debounce timer immediately to prevent reentrancy while awaiting tasks
		if (this.debouncedSaveTimer) {
			clearTimeout(this.debouncedSaveTimer);
			this.debouncedSaveTimer = null;
			this.debouncedSaveDeadline = null;
		}

		// Await any in-flight full workspace sync
		await this.waitForActiveSync();

		// Drain all active in-flight file updates first so latest edits commit to RAM before saving
		while (this.activeFileUpdates.size > 0) {
			await Promise.allSettled(Array.from(this.activeFileUpdates.values()));
		}

		// Await any active in-flight save before starting final save
		while (this.activeSavePromise) {
			await this.activeSavePromise;
		}

		const saveTask = (async () => {
			this.saveToDisk();
		})();
		this.activeSavePromise = saveTask;
		try {
			await saveTask;
		} finally {
			if (this.activeSavePromise === saveTask) {
				this.activeSavePromise = null;
			}
		}
	}

	/**
	 * Synchronize and incrementally update workspace index.
	 */
	public async syncWorkspace(
		forceReindex = false,
		onProgress?: (msg: string) => void,
	): Promise<{ chunkCount: number; fileCount: number; indexedCount: number }> {
		if (this.activeSync) return this.activeSync;

		const sync = (async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const syncGeneration = this.generation;
				const result = await this.performSyncWorkspace(
					forceReindex && attempt === 0,
					onProgress,
					syncGeneration,
				);
				if (
					this.generation !== syncGeneration ||
					!this.isWorkspaceSnapshotFresh()
				) {
					this.isInitialized = false;
					continue;
				}
				this.dirtyFiles.clear();
				return result;
			}
			this.isInitialized = false;
			throw new Error("Workspace changed repeatedly while indexing; search was not refreshed.");
		})();
		this.activeSync = sync;
		try {
			return await sync;
		} finally {
			if (this.activeSync === sync) this.activeSync = null;
		}
	}

	private getWorkspaceIgnoreHashes(): Map<string, string> {
		const hashes = new Map<string, string>();
		const gitIgnorePath = path.join(this.cwd, ".gitignore");
		if (fs.existsSync(gitIgnorePath)) {
			try {
				hashes.set(".gitignore", computeHash(fs.readFileSync(gitIgnorePath, "utf8")));
			} catch (e) {
				kernelDebug(e);
			}
		}
		const piIgnorePath = path.join(this.cwd, ".piignore");
		if (fs.existsSync(piIgnorePath)) {
			try {
				hashes.set(".piignore", computeHash(fs.readFileSync(piIgnorePath, "utf8")));
			} catch (e) {
				kernelDebug(e);
			}
		}
		return hashes;
	}

	private isIgnoreConfigFresh(): boolean {
		const current = this.getWorkspaceIgnoreHashes();
		if (current.size !== this.ignoreConfigHashes.size) return false;
		for (const [k, v] of this.ignoreConfigHashes.entries()) {
			if (current.get(k) !== v) return false;
		}
		return true;
	}

	private getWorkspaceFileHashes(): Map<string, string> | null {
		const hashes = new Map<string, string>();
		for (const filePath of findChunkableFiles(this.cwd)) {
			const relPath = path.relative(this.cwd, filePath).replace(/\\/g, "/");
			try {
				hashes.set(relPath, computeHash(fs.readFileSync(filePath, "utf8")));
			} catch (error) {
				kernelDebug(error);
				return null;
			}
		}
		return hashes;
	}

	private isWorkspaceSnapshotFresh(): boolean {
		if (!this.isIgnoreConfigFresh()) return false;
		const currentHashes = this.getWorkspaceFileHashes();
		if (!currentHashes || currentHashes.size !== this.fileHashes.size) return false;
		for (const [relPath, hash] of this.fileHashes.entries()) {
			if (currentHashes.get(relPath) !== hash) return false;
		}
		return true;
	}

	private async waitForActiveSync(): Promise<void> {
		while (this.activeSync) {
			const sync = this.activeSync;
			try {
				await sync;
			} catch (error) {
				if (this.activeSync === sync) throw error;
			}
			if (this.activeSync === sync) return;
		}
	}

	private async ensureWorkspaceSnapshotFresh(): Promise<void> {
		await this.waitForActiveSync();
		if (this.liveCheckPromise) {
			const check = this.liveCheckPromise;
			const isFresh = await check;
			if (this.liveCheckPromise === check) {
				if (!isFresh) {
					this.isInitialized = false;
					await this.waitForActiveSync();
					if (this.dirtyFiles.size > 0 || !this.isInitialized) {
						await this.syncWorkspace(false);
					}
				}
				return;
			}
			return this.ensureWorkspaceSnapshotFresh();
		}
		const check = Promise.resolve().then(() => this.isWorkspaceSnapshotFresh());
		this.liveCheckPromise = check;
		try {
			const isFresh = await check;
			if (!isFresh) {
				this.isInitialized = false;
				await this.waitForActiveSync();
				if (this.dirtyFiles.size > 0 || !this.isInitialized) {
					await this.syncWorkspace(false);
				}
			}
		} finally {
			if (this.liveCheckPromise === check) this.liveCheckPromise = null;
		}
	}

	private async performSyncWorkspace(
		forceReindex: boolean,
		onProgress: ((msg: string) => void) | undefined,
		syncGeneration: number,
	): Promise<{ chunkCount: number; fileCount: number; indexedCount: number }> {
		this.isIndexing = true;
		try {
			if (
				!this.isInitialized &&
				!forceReindex &&
				this.dirtyFiles.size === 0
			) {
				this.loadFromDisk();
			}

			onProgress?.("Scanning workspace files...");

			// Ensure Tree-sitter parsers are warm for languages present in this workspace
			const chunkableFiles = findChunkableFiles(this.cwd);
			const workspaceExts = new Set<string>();
			for (const f of chunkableFiles) {
				const ext = path.extname(f).toLowerCase();
				if (ext) workspaceExts.add(ext);
			}
			await TreeSitterEngine.getInstance().loadLanguages(Array.from(workspaceExts));

			// Read each file once and derive both its chunks and hash from that same
			// snapshot. A second read could pair old chunks with a new hash and make
			// the final freshness check falsely accept stale content.
			const currentFiles = new Map<
				string,
				{ hash: string; chunks: CodeChunk[] }
			>();
			for (const absPath of chunkableFiles) {
				const relPath = path.relative(this.cwd, absPath).replace(/\\/g, "/");
				try {
					const content = fs.readFileSync(absPath, "utf-8");
					currentFiles.set(relPath, {
						hash: computeHash(content),
						chunks: chunkFile(this.cwd, absPath, content),
					});
				} catch (error) {
					kernelDebug(error);
				}
			}

			// Identify changed, added, or deleted files. A profile upgrade from BM25
			// to vector retrieval must also embed unchanged chunks that have no vector.
			const filesToReindex: string[] = [];
			const filesToDelete: string[] = [];
			const wantsVectors =
				this.config.effectiveProfile === "hybrid" ||
				this.config.effectiveProfile === "full";

			for (const [relPath, info] of currentFiles.entries()) {
				const oldHash = this.fileHashes.get(relPath);
				const missingFileVectors = wantsVectors && info.chunks.some((chunk) => {
					const vector = this.vectors.get(chunk.id);
					return !vector || vector.length !== this.config.matryoshkaDim;
				});
				if (forceReindex || missingFileVectors || !oldHash || oldHash !== info.hash) {
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
					const embedStartTime = Date.now();

					for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
						const batch = chunksToEmbed.slice(i, i + batchSize);
						const texts = batch.map((c) => c.textForEmbedding);
						const processed = Math.min(i + batch.length, chunksToEmbed.length);
						const pct = Math.round((processed / chunksToEmbed.length) * 100);
						const elapsedSec = Math.max(0.001, (Date.now() - embedStartTime) / 1000);
						const chunkSpeed = (processed / elapsedSec).toFixed(1);
						onProgress?.(
							`Embedding code chunks: ${pct}% (${processed}/${chunksToEmbed.length} • ${chunkSpeed} chunk/s)`,
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

			// Track ignore configuration hashes in dedicated metadata
			const oldIgnoreHashes = new Map(this.ignoreConfigHashes);
			const currentIgnoreHashes = this.getWorkspaceIgnoreHashes();
			let ignoreConfigChanged = currentIgnoreHashes.size !== oldIgnoreHashes.size;
			if (!ignoreConfigChanged) {
				for (const [k, v] of currentIgnoreHashes.entries()) {
					if (oldIgnoreHashes.get(k) !== v) {
						ignoreConfigChanged = true;
						break;
					}
				}
			}
			this.ignoreConfigHashes = currentIgnoreHashes;

			if (filesToDelete.length > 0 || filesToReindex.length > 0 || ignoreConfigChanged) {
				this.saveToDisk();
			}

			this.isInitialized = true;
			return {
				chunkCount: this.chunks.size,
				fileCount: this.fileHashes.size,
				indexedCount: filesToReindex.length + filesToDelete.length,
			};
		} finally {
			this.isIndexing = false;
			if (this.generation !== syncGeneration) this.isInitialized = false;
		}
	}

	/**
	 * Transactional incremental update of a single file in the index.
	 * Chunks only this file, reuses existing vectors for unchanged chunks by content hash,
	 * embeds only new/modified chunks off-to-the-side, and commits atomically.
	 */
	public async updateFile(filePath: string): Promise<void> {
		if (this.isShuttingDown) return;

		const resolvedPath = path.resolve(this.cwd, filePath);
		const relPath = path
			.relative(this.cwd, resolvedPath)
			.replace(/\\/g, "/");
		if (
			!relPath ||
			relPath === ".." ||
			relPath.startsWith("../") ||
			path.isAbsolute(relPath)
		) return;

		// If a full workspace sync is active, mark dirty and let full sync capture the latest file content
		if (this.isIndexing || this.activeSync) {
			this.dirtyFiles.add(relPath);
			return;
		}

		const currentGen = (this.fileGenerations.get(relPath) ?? 0) + 1;
		this.fileGenerations.set(relPath, currentGen);

		const task = (async () => {
			if (this.fileGenerations.get(relPath) !== currentGen) return;

			// Check if file was deleted
			if (!fs.existsSync(resolvedPath)) {
				if (this.fileGenerations.get(relPath) !== currentGen) return;
				this.bm25.removeFile(relPath);
				this.fileHashes.delete(relPath);
				for (const chunkId of Array.from(this.chunks.keys())) {
					if (chunkId.startsWith(`${relPath}:`)) {
						this.chunks.delete(chunkId);
						this.vectors.delete(chunkId);
					}
				}
				this.dirtyFiles.delete(relPath);
				this.bm25.recalculateStats();
				this.scheduleDebouncedSave();
				return;
			}

			// Read file content with TOCTOU protection
			let content: string;
			try {
				content = fs.readFileSync(resolvedPath, "utf-8");
			} catch (err: any) {
				if (err?.code === "ENOENT") {
					// File was removed concurrently between existsSync and readFileSync
					if (this.fileGenerations.get(relPath) !== currentGen) return;
					this.bm25.removeFile(relPath);
					this.fileHashes.delete(relPath);
					for (const chunkId of Array.from(this.chunks.keys())) {
						if (chunkId.startsWith(`${relPath}:`)) {
							this.chunks.delete(chunkId);
							this.vectors.delete(chunkId);
						}
					}
					this.dirtyFiles.delete(relPath);
					this.bm25.recalculateStats();
					this.scheduleDebouncedSave();
					return;
				}
				kernelDebug(`Failed reading ${resolvedPath} for updateFile: ${err}`);
				return;
			}

			const fileHash = computeHash(content);
			// If file hasn't changed at all and is already indexed, nothing to do
			if (this.fileHashes.get(relPath) === fileHash && !this.dirtyFiles.has(relPath)) {
				return;
			}

			// Ensure TreeSitter parser for this file's language is loaded
			const ext = path.extname(resolvedPath).toLowerCase();
			if (ext) {
				try {
					await TreeSitterEngine.getInstance().loadLanguages([ext]);
				} catch (e) {
					kernelDebug(e);
				}
			}

			const newChunks = chunkFile(this.cwd, resolvedPath, content);
			const wantsVectors =
				this.config.effectiveProfile === "hybrid" ||
				this.config.effectiveProfile === "full";

			// Map content hash -> vector from existing chunks
			const hashToVector = new Map<string, Float32Array>();
			for (const chunk of this.chunks.values()) {
				const vec = this.vectors.get(chunk.id);
				if (vec && vec.length === this.config.matryoshkaDim) {
					hashToVector.set(chunk.hash, vec);
				}
			}

			const newVectors = new Map<string, Float32Array>();
			const missingChunks: CodeChunk[] = [];

			for (const chunk of newChunks) {
				const reused = hashToVector.get(chunk.hash);
				if (reused) {
					newVectors.set(chunk.id, reused);
				} else if (wantsVectors) {
					missingChunks.push(chunk);
				}
			}

			// Embed missing chunks off to the side
			if (wantsVectors && missingChunks.length > 0) {
				const batchSize = this.config.batchSize || 2;
				const texts = missingChunks.map((c) => c.textForEmbedding);
				for (let i = 0; i < missingChunks.length; i += batchSize) {
					// Check generation before each batch
					if (this.fileGenerations.get(relPath) !== currentGen) return;
					const batchChunks = missingChunks.slice(i, i + batchSize);
					const batchTexts = texts.slice(i, i + batchSize);
					const vecs = await this.embedder.embedBatch(batchTexts, false);
					for (let j = 0; j < batchChunks.length; j++) {
						if (vecs[j]) {
							newVectors.set(batchChunks[j].id, vecs[j]);
						}
					}
				}
			}

			// Generation check: if a newer update started, discard this older result
			if (this.fileGenerations.get(relPath) !== currentGen) {
				return;
			}

			// Atomic in-memory swap:
			this.bm25.removeFile(relPath);
			for (const chunkId of Array.from(this.chunks.keys())) {
				if (chunkId.startsWith(`${relPath}:`)) {
					this.chunks.delete(chunkId);
					this.vectors.delete(chunkId);
				}
			}

			this.fileHashes.set(relPath, fileHash);
			for (const chunk of newChunks) {
				this.chunks.set(chunk.id, chunk);
				this.bm25.addChunk(chunk);
				const vec = newVectors.get(chunk.id);
				if (vec) {
					this.vectors.set(chunk.id, vec);
				}
			}
			this.bm25.recalculateStats();
			this.dirtyFiles.delete(relPath);
			if (this.dirtyFiles.size === 0) {
				this.isInitialized = true;
			}

			this.scheduleDebouncedSave();
		})();

		this.activeFileUpdates.set(relPath, task);
		try {
			await task;
		} finally {
			if (this.activeFileUpdates.get(relPath) === task) {
				this.activeFileUpdates.delete(relPath);
			}
		}
	}

	/**
	 * Drop cached chunks for a file; the next search performs an incremental rescan.
	 */
	public invalidateFile(filePath: string): void {
		const resolvedPath = path.resolve(this.cwd, filePath);
		const relPath = path
			.relative(this.cwd, resolvedPath)
			.replace(/\\/g, "/");
		if (
			!relPath ||
			relPath === ".." ||
			relPath.startsWith("../") ||
			path.isAbsolute(relPath)
		) return;
		this.bm25.removeFile(relPath);
		this.fileHashes.delete(relPath);
		for (const chunkId of Array.from(this.chunks.keys())) {
			if (chunkId.startsWith(`${relPath}:`)) {
				this.chunks.delete(chunkId);
				this.vectors.delete(chunkId);
			}
		}
		this.bm25.recalculateStats();
		this.generation++;
		this.dirtyFiles.add(relPath);
		this.isInitialized = false;
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
			/** Bounded RRF smoothing constant; defaults to 60. */
			rrfK?: number;
			/** Search scope. Code is the default; all/prose are explicit opt-ins. */
			scope?: "code" | "all" | "prose";
		} = {},
	): Promise<SearchHit[]> {
		// Do not return the previous snapshot while a background synchronization
		// is active. This also covers startup/reindex work where the old index is
		// still initialized and would otherwise look usable.
		await this.waitForActiveSync();
		if (this.activeFileUpdates.size > 0) {
			await Promise.all(Array.from(this.activeFileUpdates.values()));
		}
		if (this.dirtyFiles.size > 0 || !this.isInitialized) {
			if (!this.isIndexing) {
				await this.syncWorkspace(false);
			}
		}

		if (this.isInitialized && !this.isIndexing) {
			await this.ensureWorkspaceSnapshotFresh();
		}

		const limit = options.limit || 5;
		const k = Math.max(1, Math.min(Math.floor(options.rrfK ?? 60), 200));
		const scope = options.scope ?? "code";
		const isProsePath = isProseFilePath;
		const matchesScope = (chunk: CodeChunk): boolean => {
			const isProse = isProsePath(chunk.filePath);
			return scope === "all" || (scope === "prose" ? isProse : !isProse);
		};
		const matchesFilePattern = (chunk: CodeChunk): boolean =>
			!options.filePattern ||
			chunk.filePath
				.replace(/\\/g, "/")
				.toLowerCase()
				.includes(options.filePattern.replace(/\\/g, "/").toLowerCase());
		const activeConfig = options.profile
			? getSearchConfig(options.profile)
			: this.config;

		// 1. BM25 Search (Instant AST-tokenized lexical retrieval)
		const bm25Results = this.bm25.search(query, 100, (chunkId) => {
			const chunk = this.chunks.get(chunkId);
			return !!chunk && matchesScope(chunk) && matchesFilePattern(chunk);
		});
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
			wantsVectors &&
			!this.isIndexing &&
			this.vectors.size === this.chunks.size &&
			this.vectors.size > 0 &&
			Array.from(this.vectors.values()).every(
				(vector) => vector.length === activeConfig.matryoshkaDim,
			);

		if (isVectorReady) {
			const queryVec = await this.embedder.embed(query, true);
			if (queryVec) {
				const vecScores: { chunkId: string; score: number }[] = [];
				for (const [chunkId, vec] of this.vectors.entries()) {
					const chunk = this.chunks.get(chunkId);
					if (!chunk || !matchesScope(chunk) || !matchesFilePattern(chunk)) continue;
					const score = LocalEmbedder.cosineSimilarity(queryVec, vec);
					vecScores.push({ chunkId, score });
				}

				vecScores.sort((a, b) => b.score - a.score);
				const threshold = activeConfig.vectorSimilarityThreshold;
				vecScores
					.filter((item) => item.score >= threshold)
					.slice(0, 100)
					.forEach((item, idx) => {
						vectorRankMap.set(item.chunkId, {
							rank: idx + 1,
							score: item.score,
						});
					});
			}
		}

		// 3. Reciprocal Rank Fusion (RRF)
		const candidateIds = new Set([
			...bm25RankMap.keys(),
			...vectorRankMap.keys(),
		]);
		const hits: SearchHit[] = [];

		for (const chunkId of candidateIds) {
			const chunk = this.chunks.get(chunkId);
			if (!chunk) continue;


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
				signal: bmData && vecData ? "hybrid" : vecData ? "semantic" : "lexical",
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
