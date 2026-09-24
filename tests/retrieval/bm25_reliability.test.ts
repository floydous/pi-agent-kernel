import assert from "node:assert";
import { BM25Engine } from "../../src/retrieval/search_bm25";
import type { CodeChunk } from "../../src/retrieval/search_chunker";

function makeChunk(id: string, filePath: string, symbolName: string, content: string): CodeChunk {
	return {
		id,
		filePath,
		absolutePath: filePath,
		startLine: 1,
		endLine: 1,
		symbolName,
		kind: "function",
		signature: `function ${symbolName}()`,
		breadcrumb: `${filePath} > ${symbolName}`,
		content,
		textForEmbedding: content,
		hash: content,
	};
}

export async function run(): Promise<void> {
	console.log("=== Running BM25 Reliability Tests ===");

	const engine = new BM25Engine();
	const target = makeChunk("src/a.ts:1-1#target", "src/a.ts", "target", "export const target = 1;");
	const lookalike = makeChunk("src/a.ts.bak:1-1#lookalike", "src/a.ts.bak", "lookalike", "export const lookalike = 1;");
	engine.indexChunks([target, lookalike]);
	engine.removeFile("src/a.ts");
	assert.deepStrictEqual(
		engine.search("lookalike").map((hit) => hit.chunkId),
		[lookalike.id],
		"removeFile must only remove chunks belonging to the exact path",
	);

	const zChunk = makeChunk("src/z.ts:1-1#shared", "src/z.ts", "shared", "const common = 1; return common;");
	const aChunk = makeChunk("src/a.ts:1-1#shared", "src/a.ts", "shared", "const common = 1; return common;");
	for (const order of [[zChunk, aChunk], [aChunk, zChunk]]) {
		const tieEngine = new BM25Engine();
		tieEngine.indexChunks(order);
		for (let repeat = 0; repeat < 4; repeat++) {
			assert.deepStrictEqual(
				tieEngine.search("common").map((hit) => hit.chunkId),
				[aChunk.id, zChunk.id],
				"equal-score results must use a stable chunk-ID tie-breaker",
			);
		}
		tieEngine.removeFile("src/z.ts");
		tieEngine.addChunk(zChunk);
		tieEngine.recalculateStats();
		assert.deepStrictEqual(
			tieEngine.search("common").map((hit) => hit.chunkId),
			[aChunk.id, zChunk.id],
			"equal-score ordering must survive an update that changes insertion order",
		);
	}

	const incremental = new BM25Engine();
	const docs = new Map<string, CodeChunk>();
	const add = (chunk: CodeChunk) => {
		docs.set(chunk.id, chunk);
		incremental.addChunk(chunk);
	};
	add(makeChunk("src/one.ts:1-1#one", "src/one.ts", "one", "export const one = 1;"));
	add(makeChunk("src/two.ts:1-1#two", "src/two.ts", "two", "export const two = 2;"));
	for (let i = 0; i < 50; i++) {
		const id = i % 2 === 0 ? "src/one.ts:1-1#one" : "src/two.ts:1-1#two";
		const old = docs.get(id)!;
		const replacement = makeChunk(id, old.filePath, old.symbolName, `${old.content}\n// revision ${i}`);
		incremental.removeFile(old.filePath);
		docs.set(id, replacement);
		add(replacement);
		incremental.recalculateStats();

		const fresh = new BM25Engine();
		fresh.indexChunks(Array.from(docs.values()));
		assert.deepStrictEqual(
			incremental.search("one").map((hit) => hit.chunkId),
			fresh.search("one").map((hit) => hit.chunkId),
			`incremental top-k order diverged at mutation ${i}`,
		);
		assert.deepStrictEqual(
			incremental.search("two").map((hit) => hit.chunkId),
			fresh.search("two").map((hit) => hit.chunkId),
			`incremental top-k order diverged at mutation ${i}`,
		);
	}

	console.log("✓ Exact path removal, deterministic ties, and incremental parity verified!");
}

if (require.main === module) {
	void run();
}
