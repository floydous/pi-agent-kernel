import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { createTestWorkspace, PY_CODE, assertPass, logPass } from "../_setup";
import * as fs from "node:fs";

export async function testSearchRetrieval(): Promise<void> {
	const ws = createTestWorkspace("search_retrieval_");
	try {
		fs.writeFileSync(ws.calculatorPath, PY_CODE, "utf8");
		const searchIndex = new HybridSearchIndex(ws.tempDir, "lean");
		const searchHits = await searchIndex.search("calculate_tax discount precision", { limit: 2 });
		assertPass("Code search returns at least one hit", searchHits.length > 0, { searchHits });
		assertPass("Top hit's content includes 'calculate_tax'", searchHits[0].chunk.content.includes("calculate_tax"), { searchHits });
		logPass(`Code search retrieval passed (Top hit: ${searchHits[0].chunk.id} RRF: ${searchHits[0].rrfScore.toFixed(4)})!`);
	} finally {
		ws.cleanup();
	}
}
