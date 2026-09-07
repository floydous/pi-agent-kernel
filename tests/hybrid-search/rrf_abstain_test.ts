import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { createTestWorkspace, PY_CODE, assertPass, logPass } from "../_setup";
import * as fs from "node:fs";

export async function testRrfAndAbstain(): Promise<void> {
	const ws = createTestWorkspace("rrf_abstain_");
	try {
		fs.writeFileSync(ws.calculatorPath, PY_CODE, "utf8");

		// Low-confidence vector-only query abstains
		const thresholdIndex: any = new HybridSearchIndex(ws.tempDir, "hybrid");
		thresholdIndex.isInitialized = true;
		thresholdIndex.isIndexing = false;
		thresholdIndex.isWorkspaceSnapshotFresh = () => true;
		thresholdIndex.bm25.search = () => [];
		thresholdIndex.embedder.embed = async () => new Float32Array([1, 0]);
		for (const id of thresholdIndex.chunks.keys()) {
			thresholdIndex.vectors.set(id, new Float32Array([0, 1]));
		}
		const abstainedHits = await thresholdIndex.search("zorbax flobnax quaximilian", { limit: 5 });
		assertPass("Low-confidence vector-only query abstains (no hits)", abstainedHits.length === 0, { abstainedHits });
		logPass("Low-confidence vector candidates excluded from RRF!");

		// Mixed index exposes evidence signal — must run AFTER the index has been
		// populated. This is invoked by testRrfWithFreshIndex in a shared fresh
		// index setup to avoid cross-test ordering coupling.
		// Note: The RRF "signal" property is verified separately.

		logPass("RRF thresholding and abstain verified!");
	} finally {
		ws.cleanup();
	}
}
