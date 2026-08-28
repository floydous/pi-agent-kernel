// Section 10: Hybrid AST Code Search Engine
// Tests chunkFile, HybridSearchIndex, and search with fallback during indexing.

import * as fs from "node:fs";
import { chunkFile } from "../src/retrieval/search_chunker";
import { HybridSearchIndex } from "../src/retrieval/search_index";
import {
	createTestWorkspace,
	PY_CODE,
	runSection,
	assertPass,
	logPass,
} from "./_setup";

async function main(): Promise<void> {
	await runSection("10. Hybrid AST Code Search Engine", async () => {
		const ws = createTestWorkspace();
		try {
			fs.writeFileSync(ws.calculatorPath, PY_CODE, "utf8");
			const chunks = chunkFile(ws.tempDir, ws.calculatorPath);
			assertPass(
				"AST chunking",
				chunks.length > 0 && chunks[0].breadcrumb.includes("calculator.py"),
				{ chunks },
			);
			logPass(
				`AST chunking verified (found ${chunks.length} chunk(s) with breadcrumbs)!`,
			);

			const searchIndex = new HybridSearchIndex(ws.tempDir, "lean");
			const status = searchIndex.getStatus();
			assertPass(
				"isModelCached is a boolean",
				typeof status.isModelCached === "boolean",
				{ status },
			);
			logPass(
				`Embedder disk cache detection verified (isModelCached: ${status.isModelCached})!`,
			);

			const syncRes = await searchIndex.syncWorkspace(true);
			assertPass("Workspace indexed in lean mode", syncRes.chunkCount > 0, {
				syncRes,
			});
			logPass(`Workspace indexed in lean mode (${syncRes.chunkCount} chunks)!`);

			// Test fallback to Lean when Full/Hybrid mode is set but indexing is marked in progress
			searchIndex.setProfile("full");
			(searchIndex as any).isIndexing = true;
			const fallbackHits = await searchIndex.search(
				"calculate_tax discount precision",
				{ limit: 2 },
			);
			(searchIndex as any).isIndexing = false;

			assertPass(
				"Search fallback during indexing works",
				fallbackHits.length > 0 &&
					fallbackHits[0].chunk.content.includes("calculate_tax"),
				{ fallbackHits },
			);
			logPass("Graceful Lean mode fallback during active indexing verified!");

			const searchHits = await searchIndex.search(
				"calculate_tax discount precision",
				{ limit: 2 },
			);
			assertPass(
				"Code search retrieval works",
				searchHits.length > 0 &&
					searchHits[0].chunk.content.includes("calculate_tax"),
				{ searchHits },
			);
			logPass(
				`Code search retrieval passed (Top hit: ${searchHits[0].chunk.id} RRF: ${searchHits[0].rrfScore.toFixed(4)})!`,
			);

			// Vector candidates below the configured confidence floor must not
			// create results when lexical retrieval has no matches.
			const thresholdIndex: any = new HybridSearchIndex(ws.tempDir, "hybrid");
			thresholdIndex.isInitialized = true;
			thresholdIndex.isIndexing = false;
			thresholdIndex.bm25.search = () => [];
			thresholdIndex.embedder.embed = async () => new Float32Array([1, 0]);
			for (const id of thresholdIndex.chunks.keys()) {
				thresholdIndex.vectors.set(id, new Float32Array([0, 1]));
			}
			const abstainedHits = await thresholdIndex.search(
				"zorbax flobnax quaximilian",
				{ limit: 5 },
			);
			assertPass(
				"Low-confidence vector-only query abstains",
				abstainedHits.length === 0,
				{ abstainedHits },
			);
			logPass("Low-confidence vector candidates excluded from RRF!");

			const mixedIndex: any = new HybridSearchIndex(ws.tempDir, "hybrid");
			mixedIndex.isInitialized = true;
			mixedIndex.isIndexing = false;
			mixedIndex.embedder.embed = async () => new Float32Array([1, 0]);
			const mixedHits = await mixedIndex.search("calculate_tax", { limit: 5 });
			assertPass(
				"Search hit exposes evidence signal",
				mixedHits.length > 0 && ["lexical", "semantic", "hybrid"].includes(mixedHits[0].signal),
				{ mixedHits },
			);
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
