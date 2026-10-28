import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkFile } from "../../src/retrieval/search_chunker";
import { DENSE_SIMILARITY_FLOOR, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION, getSearchConfig } from "../../src/retrieval/search_config";
import { LocalEmbedder } from "../../src/retrieval/search_embedder";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";

const CURRENT_MODEL = `${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_REVISION}`;

export async function run(): Promise<void> {
	console.log("=== Running Dense Profile Suite ===");

	console.log("1. \"hybrid\" resolves to the full profile; auto picks full from 4 CPUs...");
	const hybrid = getSearchConfig("hybrid");
	assert.equal(hybrid.effectiveProfile, "full");
	assert.equal(hybrid.profile, "hybrid", "the requested name is kept for display and persistence");
	const full = getSearchConfig("full");
	assert.equal(full.matryoshkaDim, 768);
	assert.equal(full.batchSize, 1, "one text per embedding call");
	assert.equal(full.vectorSimilarityThreshold, DENSE_SIMILARITY_FLOOR);
	const nodeOs = require("node:os");
	const cpus = nodeOs.cpus;
	try {
		nodeOs.cpus = () => new Array(4).fill(cpus()[0]);
		assert.equal(getSearchConfig("auto").effectiveProfile, "full");
		nodeOs.cpus = () => new Array(2).fill(cpus()[0]);
		assert.equal(getSearchConfig("auto").effectiveProfile, "lean");
	} finally {
		nodeOs.cpus = cpus;
	}

	console.log("2. The embedder sends plain text (no task prefix), CLS-pooled and normalized, cut at 1,800 chars...");
	const embedder: any = new LocalEmbedder(full);
	const calls: Array<{ texts: string[]; options: any }> = [];
	embedder.extractor = async (texts: string[], options: any) => {
		calls.push({ texts, options });
		return { data: new Float32Array(texts.length * 768).fill(0.5), dims: [texts.length, 768] };
	};
	const docVectors = await embedder.embedBatch(["x".repeat(3000)], false);
	const queryVector = await embedder.embed("find the retry loop", true);
	assert.equal(docVectors.length, 1);
	assert.equal(docVectors[0].length, 768);
	assert.equal(queryVector.length, 768);
	assert.equal(calls[0].texts[0], "x".repeat(1800));
	assert.equal(calls[1].texts[0], "find the retry loop");
	for (const call of calls) assert.deepEqual(call.options, { pooling: "cls", normalize: true });

	console.log("3. Only vector caches from the current model are loaded, and new saves are tagged...");
	const previousPiDir = process.env.PI_DIR;
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dense-profile-"));
	process.env.PI_DIR = path.join(base, "pi");
	try {
		await TreeSitterEngine.getInstance().loadLanguages([".ts"]);
		const workspace = path.join(base, "workspace");
		fs.mkdirSync(workspace, { recursive: true });
		const source = "export function retry(attempts: number): number {\n  return attempts + 1;\n}\n";
		fs.writeFileSync(path.join(workspace, "retry.ts"), source);
		const { HybridSearchIndex, getSearchCacheDir } = require("../../src/retrieval/search_index");
		const { computeHash } = require("../../src/retrieval/search_chunker");
		const chunks = chunkFile(workspace, path.join(workspace, "retry.ts"), source);
		const ids = chunks.map((c) => c.id);
		const buffer = Buffer.alloc(ids.length * 768 * 4);
		new Float32Array(buffer.buffer, buffer.byteOffset, ids.length * 768).fill(0.25);
		const vectorHash = crypto.createHash("sha256").update(JSON.stringify(ids)).update(buffer).digest("hex");
		const cacheDir = getSearchCacheDir(workspace);
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, "vectors-768d.bin"), buffer);
		const loadWith = (model: string | undefined) => {
			const cache: any = { vectorDim: 768, vectorChunkIds: ids, vectorChunkHashes: chunks.map((c) => c.hash), vectorHash, fileName: "vectors-768d.bin" };
			if (model !== undefined) cache.model = model;
			fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify({
				version: 4, extractorGeneration: "tree-sitter-wasm-v6", fileHashes: { "retry.ts": computeHash(source) },
				ignoreConfigHashes: {}, chunks, vectorCaches: [cache],
			}));
			const index = new HybridSearchIndex(workspace, "full", { projectTrusted: true });
			assert.equal(index.loadFromDisk(), true, "chunks load regardless of the vector cache");
			return index;
		};
		assert.equal(loadWith(CURRENT_MODEL).getStatus().vectorCount, ids.length, "current-model vectors load");
		assert.equal(loadWith(undefined).getStatus().vectorCount, 0, "untagged vectors predate model tags and are not loaded");
		assert.equal(loadWith("nomic-ai/nomic-embed-text-v1.5@e9b6763023c676ca8431644204f50c2b100d9aab").getStatus().vectorCount, 0, "another model's vectors are not loaded");
		const tagged = loadWith(CURRENT_MODEL);
		tagged.saveToDisk();
		const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, "index.json"), "utf8"));
		assert.deepEqual(saved.vectorCaches.map((c: any) => c.model), [CURRENT_MODEL], "saved caches name their model");
		await tagged.flushPendingSave?.(true);
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(base, { recursive: true, force: true });
	}

	console.log("✓ One dense profile on the code embedder, plain-text CLS embeddings, and model-tagged vector caches!");
}

if (require.main === module) {
	void run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
