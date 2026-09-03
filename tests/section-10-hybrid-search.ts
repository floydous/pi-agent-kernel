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
			// This branch intentionally seeds private index state to test vector
			// ranking; do not let live-freshness probing trigger a real reindex.
			thresholdIndex.isWorkspaceSnapshotFresh = () => true;
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
			// This branch intentionally seeds private index state to test RRF
			// ranking; do not let live-freshness probing trigger a real reindex.
			mixedIndex.isWorkspaceSnapshotFresh = () => true;
			mixedIndex.embedder.embed = async () => new Float32Array([1, 0]);
			const mixedHits = await mixedIndex.search("calculate_tax", { limit: 5 });
			assertPass(
				"Search hit exposes evidence signal",
				mixedHits.length > 0 && ["lexical", "semantic", "hybrid"].includes(mixedHits[0].signal),
				{ mixedHits },
			);
			logPass("Search hit exposes evidence signal!");
			const tunedHits = await mixedIndex.search("calculate_tax", {
				limit: 5,
				rrfK: 120,
			});
			assertPass(
				"RRF smoothing constant is bounded and configurable",
				tunedHits.length > 0 && tunedHits[0].rrfScore < mixedHits[0].rrfScore,
				{ tunedHits, mixedHits },
			);
			logPass("RRF smoothing constant is bounded and configurable!");

			// A successful mutation must invalidate the cached file so the next
			// search refreshes it instead of serving stale chunks.
			const staleFixture = `${ws.tempDir}/stale_fixture.ts`;
			fs.writeFileSync(staleFixture, "export function marker() { return 'oldMarker'; }\n", "utf8");
			const staleIndex = new HybridSearchIndex(ws.tempDir, "lean");
			await staleIndex.syncWorkspace(true);
			const oldHits = await staleIndex.search("oldMarker", { limit: 5 });
			fs.writeFileSync(staleFixture, "export function marker() { return 'newMarker'; }\n", "utf8");
			staleIndex.invalidateFile(staleFixture);
			const refreshedHits = await staleIndex.search("newMarker", { limit: 5 });
			assertPass(
				"Invalidated search file is refreshed before the next query",
				refreshedHits.some((hit) => hit.chunk.content.includes("newMarker")) &&
					!refreshedHits.some((hit) => hit.chunk.content.includes("oldMarker")) &&
					oldHits.some((hit) => hit.chunk.content.includes("oldMarker")),
				{ oldHits, refreshedHits },
			);
			fs.writeFileSync(staleFixture, "export function marker() { return 'externalMarker'; }\n", "utf8");
			const externalHits = await staleIndex.search("externalMarker", { limit: 5 });
			assertPass(
				"Unannounced external mutation is detected before search results are returned",
				externalHits.some((hit) => hit.chunk.content.includes("externalMarker")) &&
				!externalHits.some((hit) => hit.chunk.content.includes("newMarker")) &&
				!externalHits.some((hit) => hit.chunk.content.includes("oldMarker")),
				{ externalHits },
			);

			// A mutation can arrive while background embedding is awaiting a batch.
			// The generation check must reject that snapshot and retry from disk/current
			// contents rather than leaving a mixed old/new index.
			const concurrentDir = fs.mkdtempSync(`${ws.tempDir}/concurrent-`);
			const concurrentPath = `${concurrentDir}/concurrent.ts`;
			fs.writeFileSync(
				concurrentPath,
				"export const concurrentMarker = 'oldConcurrentMarker';\n",
				"utf8",
			);
			const concurrentIndex: any = new HybridSearchIndex(concurrentDir, "hybrid");
			// Keep this fixture isolated from the normal workspace files so the
			// controlled embedding gate cannot be bypassed by an empty diff.
			let firstEmbedding = true;
			let releaseFirstEmbedding: () => void = () => {};
			let enteredFirstEmbedding: () => void = () => {};
			const firstEmbeddingEntered = new Promise<void>((resolve) => {
				enteredFirstEmbedding = resolve;
			});
			const firstEmbeddingReleased = new Promise<void>((resolve) => {
				releaseFirstEmbedding = resolve;
			});
			concurrentIndex.embedder.embedBatch = async (texts: string[]) => {
				if (firstEmbedding) {
					firstEmbedding = false;
					enteredFirstEmbedding();
					await firstEmbeddingReleased;
				}
				return texts.map(() => undefined);
			};

			const concurrentSync = concurrentIndex.syncWorkspace(true);
			const concurrentSyncSettled = Promise.race([
				concurrentSync.then(() => undefined),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("concurrent sync timed out")), 5000),
				),
			]);
			await firstEmbeddingEntered;
			fs.writeFileSync(
				concurrentPath,
				"export const concurrentMarker = 'newConcurrentMarker';\n",
				"utf8",
			);
			concurrentIndex.invalidateFile(concurrentPath);
			assertPass(
				"Invalidation remains observable while indexing is active",
				(concurrentIndex as any).dirtyFiles.has("concurrent.ts") &&
					(concurrentIndex as any).generation > 0,
				{ dirtyFiles: (concurrentIndex as any).dirtyFiles },
			);
			logPass("Invalidation remains observable while indexing is active!");
			releaseFirstEmbedding();
			await concurrentSyncSettled;
			logPass("Concurrent sync completed!");
			const concurrentNewHits = await concurrentIndex.search("newConcurrentMarker", {
				limit: 5,
			});
			const concurrentOldHits = await concurrentIndex.search("oldConcurrentMarker", {
				limit: 5,
			});
			assertPass(
				"Mutation during indexing retries to a coherent post-mutation snapshot",
				concurrentNewHits.some((hit) => hit.chunk.content.includes("newConcurrentMarker")) &&
					!concurrentOldHits.some((hit) => hit.chunk.content.includes("oldConcurrentMarker")),
				{ concurrentNewHits, concurrentOldHits },
			);
			logPass("Mutation during indexing retries to a coherent post-mutation snapshot!");
			fs.rmSync(concurrentDir, { recursive: true, force: true });
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
