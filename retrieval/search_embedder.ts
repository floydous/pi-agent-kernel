import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getSearchConfig, type SearchConfig } from "./search_config";
import { kernelDebug } from "../safety/kernel_debug";

export interface EmbeddingResult {
	vector: Float32Array;
	dim: number;
}

export class LocalEmbedder {
	private extractor: any = null;
	private layerNormFn: any = null;
	private config: SearchConfig;
	private isInitializing = false;
	private initPromise: Promise<void> | null = null;

	constructor(config?: SearchConfig) {
		this.config = config || getSearchConfig();
	}

	public updateConfig(config: SearchConfig): void {
		this.config = config;
	}

	public isLoaded(): boolean {
		return this.extractor !== null;
	}

	/**
	 * Check if model weights are already downloaded and cached locally on disk.
	 */
	public isCachedOnDisk(): boolean {
		try {
			const modelParts = this.config.modelId.split("/");
			const candidateDirs = [
				path.join(
					__dirname,
					"node_modules",
					"@huggingface",
					"transformers",
					".cache",
					...modelParts,
				),
				path.join(
					__dirname,
					"..",
					"node_modules",
					"@huggingface",
					"transformers",
					".cache",
					...modelParts,
				),
				path.join(
					process.cwd(),
					"node_modules",
					"@huggingface",
					"transformers",
					".cache",
					...modelParts,
				),
				path.join(
					os.homedir(),
					".pi",
					"agent",
					"extensions",
					"agent-kernel",
					"node_modules",
					"@huggingface",
					"transformers",
					".cache",
					...modelParts,
				),
				path.join(
					os.homedir(),
					".pi",
					"agent",
					"extensions",
					"features",
					"node_modules",
					"@huggingface",
					"transformers",
					".cache",
					...modelParts,
				),
				path.join(
					os.homedir(),
					".cache",
					"huggingface",
					"hub",
					`models--${this.config.modelId.replace("/", "--")}`,
				),
				path.join(
					os.homedir(),
					".cache",
					"huggingface",
					"transformers",
					...modelParts,
				),
				path.join(os.homedir(), ".cache", ...modelParts),
				path.join(os.homedir(), ".pi", "cache", "models", ...modelParts),
			];

			for (const dir of candidateDirs) {
				if (!fs.existsSync(dir)) continue;

				// Check for ONNX files or snapshot folders
				const onnxPath = path.join(dir, "onnx");
				if (fs.existsSync(onnxPath)) {
					const files = fs.readdirSync(onnxPath);
					if (files.some((f) => f.endsWith(".onnx"))) return true;
				}

				const snapshots = path.join(dir, "snapshots");
				if (fs.existsSync(snapshots)) {
					const files = fs.readdirSync(snapshots);
					if (files.length > 0) return true;
				}

				const rootFiles = fs.readdirSync(dir);
				if (rootFiles.some((f) => f.endsWith(".onnx") || f === "config.json")) {
					return true;
				}
			}
		} catch (e) {
			kernelDebug(e);
		}
		return false;
	}

	/**
	 * Lazy-initializes the Hugging Face Transformers pipeline with strict thread limits.
	 */
	public async initialize(onProgress?: (msg: string) => void): Promise<boolean> {
		if (this.extractor) return true;
		if (
			this.config.effectiveProfile === "off" ||
			this.config.effectiveProfile === "lean"
		) {
			return false;
		}

		if (this.initPromise) {
			await this.initPromise;
			return this.extractor !== null;
		}

		this.isInitializing = true;
		this.initPromise = (async () => {
			try {
				const cached = this.isCachedOnDisk();
				if (cached) {
					onProgress?.("Loading embedding weights into RAM...");
				} else {
					onProgress?.("Downloading embedding weights: 0% (~135 MB)...");
				}

				// Enforce single-thread CPU constraints to avoid starving system processes
				process.env.OMP_NUM_THREADS = String(this.config.numThreads || 1);
				process.env.ORT_INTRA_OP_NUM_THREADS = String(this.config.numThreads || 1);
				process.env.ORT_INTER_OP_NUM_THREADS = String(this.config.numThreads || 1);

				const { env, pipeline, layer_norm } = await import(
					"@huggingface/transformers"
				);
				if (env && env.backends && env.backends.onnx) {
					env.backends.onnx.numThreads = this.config.numThreads || 1;
					env.backends.onnx.logLevel = "warning";
				}

				this.layerNormFn = layer_norm;

				this.extractor = await pipeline("feature-extraction", this.config.modelId, {
					dtype: this.config.dtype,
					progress_callback: (p: any) => {
						if (p.status === "progress" && p.total && p.loaded) {
							const pct = Math.round((p.loaded / p.total) * 100);
							onProgress?.(`Downloading embedding weights: ${pct}%`);
						}
					},
				});

				// Strictly clamp tokenizer max sequence length to 512 tokens to prevent ONNX activation RAM explosions
				if (this.extractor?.tokenizer?.config) {
					this.extractor.tokenizer.config.model_max_length = 512;
				}

				onProgress?.("Embedding model loaded.");
			} catch (err: any) {
				console.error("[Search Embedder] Error loading pipeline:", err);
				this.extractor = null;
			} finally {
				this.isInitializing = false;
			}
		})();

		await this.initPromise;
		return this.extractor !== null;
	}

	/**
	 * Embed a single text string (document or query).
	 */
	public async embed(
		text: string,
		isQuery = false,
		onProgress?: (msg: string) => void,
	): Promise<Float32Array | null> {
		const results = await this.embedBatch([text], isQuery, onProgress);
		return results.length > 0 ? results[0] : null;
	}

	/**
	 * Embed a batch of texts with Matryoshka dimension truncation and L2 normalization.
	 */
	public async embedBatch(
		texts: string[],
		isQuery = false,
		onProgress?: (msg: string) => void,
	): Promise<Float32Array[]> {
		if (
			this.config.effectiveProfile === "off" ||
			this.config.effectiveProfile === "lean"
		) {
			return [];
		}

		if (!this.extractor) {
			const ok = await this.initialize(onProgress);
			if (!ok || !this.extractor) return [];
		}

		if (texts.length === 0) return [];

		// Apply mandatory Nomic task prefix and clamp character length to 1,800 chars (~400 tokens)
		const prefix = isQuery ? "search_query: " : "search_document: ";
		const prefixedTexts = texts.map((t) => `${prefix}${t.slice(0, 1800)}`);

		try {
			let tensorOutput = await this.extractor(prefixedTexts, {
				pooling: "mean",
				normalize: false,
			});

			const targetDim =
				this.config.matryoshkaDim > 0 ? this.config.matryoshkaDim : 768;

			// Apply LayerNorm -> Slice to Matryoshka Dim -> L2 Normalize
			if (this.layerNormFn && targetDim < 768) {
				tensorOutput = this.layerNormFn(tensorOutput, [tensorOutput.dims[1]])
					.slice(null, [0, targetDim])
					.normalize(2, -1);
			} else {
				tensorOutput = tensorOutput.normalize(2, -1);
			}

			const data: Float32Array = tensorOutput.data;
			const batchCount = tensorOutput.dims[0];
			const actualDim = tensorOutput.dims[1];

			const results: Float32Array[] = [];
			for (let b = 0; b < batchCount; b++) {
				const start = b * actualDim;
				const end = start + actualDim;
				const slice = new Float32Array(actualDim);
				slice.set(data.subarray(start, end));
				results.push(slice);
			}

			return results;
		} catch (err: any) {
			console.error("[Search Embedder] Error during batch embedding:", err);
			return [];
		}
	}

	/**
	 * Compute fast cosine similarity between two normalized vectors.
	 */
	public static cosineSimilarity(a: Float32Array, b: Float32Array): number {
		if (a.length !== b.length) return 0;
		let dot = 0;
		const len = a.length;
		for (let i = 0; i < len; i++) {
			dot += a[i] * b[i];
		}
		return dot;
	}

	/**
	 * Unload model from RAM and aggressively release native ONNX sessions and C++ heap buffers.
	 */
	public async dispose(): Promise<void> {
		if (this.extractor) {
			try {
				if (typeof this.extractor.dispose === "function") {
					await this.extractor.dispose();
				}
				if (this.extractor.model) {
					if (typeof this.extractor.model.dispose === "function") {
						await this.extractor.model.dispose();
					}
					if (this.extractor.model.session) {
						if (typeof this.extractor.model.session.release === "function") {
							await this.extractor.model.session.release();
						}
						if (typeof this.extractor.model.session.dispose === "function") {
							await this.extractor.model.session.dispose();
						}
					}
				}
				if (
					this.extractor.tokenizer &&
					typeof this.extractor.tokenizer.dispose === "function"
				) {
					await this.extractor.tokenizer.dispose();
				}
			} catch (e) {
				kernelDebug(e);
			}
		}

		this.extractor = null;
		this.layerNormFn = null;
		this.initPromise = null;

		try {
			if (typeof (global as any).gc === "function") {
				(global as any).gc();
			}
		} catch (e) {
			kernelDebug(e);
		}
	}
}
