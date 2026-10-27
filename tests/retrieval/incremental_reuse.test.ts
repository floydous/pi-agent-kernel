import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BM25Engine } from "../../src/retrieval/search_bm25";
import type { CodeChunk } from "../../src/retrieval/search_chunker";

const chunkerPath = require.resolve("../../src/retrieval/search_chunker");
const indexPath = require.resolve("../../src/retrieval/search_index");

// Load a private copy of search_index whose chunkFile calls are counted.
function loadCountingIndex(): { HybridSearchIndex: any; calls: () => number; restore: () => void } {
	const realChunker = require(chunkerPath);
	let calls = 0;
	const cachedChunker = require.cache[chunkerPath]!;
	const originalExports = cachedChunker.exports;
	cachedChunker.exports = {
		...realChunker,
		chunkFile: (...args: unknown[]) => {
			calls++;
			return realChunker.chunkFile(...args);
		},
	};
	const originalIndexModule = require.cache[indexPath];
	delete require.cache[indexPath];
	const { HybridSearchIndex } = require(indexPath);
	return {
		HybridSearchIndex,
		calls: () => calls,
		restore: () => {
			cachedChunker.exports = originalExports;
			if (originalIndexModule) require.cache[indexPath] = originalIndexModule;
			else delete require.cache[indexPath];
		},
	};
}

function writeWorkspace(dir: string): void {
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "math.ts"), "export function addNumbers(a: number, b: number): number {\n\treturn a + b;\n}\n\nexport function clampValue(v: number, lo: number, hi: number): number {\n\treturn Math.min(hi, Math.max(lo, v));\n}\n");
	fs.writeFileSync(path.join(dir, "src", "parse.ts"), "export function parseRetryLimit(input: unknown): number {\n\treturn typeof input === \"number\" ? input : 0;\n}\n");
	fs.writeFileSync(path.join(dir, "src", "format.ts"), "export function formatBounds(min: number, max: number): string {\n\treturn `${min}..${max}`;\n}\n");
}

async function snapshot(index: any, queries: string[]) {
	const internals = index as any;
	const results: Record<string, Array<[string, number]>> = {};
	for (const q of queries) results[q] = (await index.search(q, { limit: 10 })).map((h: any) => [h.chunk.id, h.bm25Score]);
	return {
		chunkIds: Array.from(internals.chunks.keys() as Iterable<string>).sort(),
		fileHashes: Array.from(internals.fileHashes.entries() as Iterable<[string, string]>).sort(),
		results,
	};
}

function makeChunk(id: string, filePath: string, content: string): CodeChunk {
	return {
		id, filePath, absolutePath: filePath, startLine: 1, endLine: 1, symbolName: id.split("#")[1] || "file",
		kind: "function", signature: content.split("\n")[0], breadcrumb: filePath, content, textForEmbedding: content, hash: content,
	};
}

export async function run(): Promise<void> {
	console.log("=== Running Incremental Index Reuse & Equivalence Tests ===");
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reuse-pidir-"));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reuse-ws-"));
	process.env.PI_DIR = piDir;
	const counting = loadCountingIndex();
	try {
		writeWorkspace(workspace);
		const queries = ["add numbers", "clamp value", "retry limit", "format bounds", "subtract numbers"];

		console.log("1. Cold build chunks every file; warm sync of unchanged files re-chunks nothing...");
		const cold = new counting.HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await cold.syncWorkspace(false);
		await cold.flushPendingSave?.(true);
		assert.equal(counting.calls(), 3, "cold build must chunk all 3 files");

		const before = counting.calls();
		const warm = new counting.HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await warm.syncWorkspace(false);
		assert.equal(counting.calls() - before, 0, "warm sync must reuse cached chunks for unchanged files");
		assert.deepEqual(await snapshot(warm, queries), await snapshot(cold, queries), "warm index must equal the cold index");

		console.log("2. After modify/add/delete, only changed or new files are chunked...");
		fs.writeFileSync(path.join(workspace, "src", "math.ts"), "export function addNumbers(a: number, b: number): number {\n\treturn a + b;\n}\n\nexport function subtractNumbers(a: number, b: number): number {\n\treturn a - b;\n}\n");
		fs.writeFileSync(path.join(workspace, "src", "extra.ts"), "export function subtractTotals(x: number): number {\n\treturn x - 1;\n}\n");
		fs.rmSync(path.join(workspace, "src", "format.ts"));
		const beforeIncremental = counting.calls();
		await warm.syncWorkspace(false);
		assert.equal(counting.calls() - beforeIncremental, 2, "only the modified and the added file may be chunked");

		console.log("3. Incrementally synced index equals a cold rebuild of the final workspace...");
		const rebuilt = new counting.HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await rebuilt.syncWorkspace(true);
		const incrementalSnapshot = await snapshot(warm, queries);
		assert.deepEqual(incrementalSnapshot, await snapshot(rebuilt, queries), "incremental index diverged from a cold rebuild");
		assert.ok(!incrementalSnapshot.chunkIds.some((id) => id.startsWith("src/format.ts:")), "deleted file chunks must be gone");
		assert.ok(incrementalSnapshot.results["subtract numbers"].length > 0, "new content must be searchable");
		await warm.flushPendingSave?.(true);
		await rebuilt.flushPendingSave?.(true);

		console.log("4. BM25 running statistics match a fresh engine exactly (scores, not just order)...");
		const incremental = new BM25Engine();
		const docs = new Map<string, CodeChunk>();
		for (let i = 0; i < 40; i++) {
			const file = `src/f${i % 5}.ts`;
			incremental.removeFile(file);
			for (const id of [...docs.keys()]) if (id.startsWith(`${file}:`)) docs.delete(id);
			const fresh = [makeChunk(`${file}:1-1#a${i}`, file, `alpha beta ${"gamma ".repeat(i % 7)}`), makeChunk(`${file}:2-2#b${i}`, file, `beta delta ${i}`)];
			for (const c of fresh) {
				docs.set(c.id, c);
				incremental.addChunk(c);
			}
			incremental.recalculateStats();
			const reference = new BM25Engine();
			reference.indexChunks(Array.from(docs.values()));
			for (const q of ["alpha", "beta", "gamma delta"]) {
				assert.deepEqual(incremental.search(q, 20), reference.search(q, 20), `BM25 scores diverged at step ${i} for '${q}'`);
			}
		}
	} finally {
		counting.restore();
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}
	console.log("✓ Incremental reuse, cold-rebuild equivalence, and BM25 statistics verified!");
}
