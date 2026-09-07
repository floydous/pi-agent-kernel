import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { createTestWorkspace, PY_CODE, assertPass, logPass } from "../_setup";
import * as fs from "node:fs";

export async function testCacheInvalidation(): Promise<void> {
	const ws = createTestWorkspace("cache_invalidation_");
	try {
		fs.writeFileSync(ws.calculatorPath, PY_CODE, "utf8");

		const staleFixture = `${ws.tempDir}/stale_fixture.ts`;
		fs.writeFileSync(staleFixture, "export function marker() { return 'oldMarker'; }\n", "utf8");
		const staleIndex = new HybridSearchIndex(ws.tempDir, "lean");
		await staleIndex.syncWorkspace(true);
		const oldHits = await staleIndex.search("oldMarker", { limit: 5 });
		assertPass("Initial oldMarker is found", oldHits.some((hit) => hit.chunk.content.includes("oldMarker")), { oldHits });

		fs.writeFileSync(staleFixture, "export function marker() { return 'newMarker'; }\n", "utf8");
		staleIndex.invalidateFile(staleFixture);
		const refreshedHits = await staleIndex.search("newMarker", { limit: 5 });
		assertPass(
			"Invalidated search file is refreshed before next query",
			refreshedHits.some((hit) => hit.chunk.content.includes("newMarker")) &&
				!refreshedHits.some((hit) => hit.chunk.content.includes("oldMarker")),
			{ refreshedHits }
		);

		// External (unannounced) mutation detection
		fs.writeFileSync(staleFixture, "export function marker() { return 'externalMarker'; }\n", "utf8");
		const externalHits = await staleIndex.search("externalMarker", { limit: 5 });
		assertPass(
			"Unannounced external mutation is detected before search results are returned",
			externalHits.some((hit) => hit.chunk.content.includes("externalMarker")) &&
				!externalHits.some((hit) => hit.chunk.content.includes("newMarker")) &&
				!externalHits.some((hit) => hit.chunk.content.includes("oldMarker")),
			{ externalHits }
		);

		logPass("Cache invalidation and external mutation detection verified!");
	} finally {
		ws.cleanup();
	}
}
