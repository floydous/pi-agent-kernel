import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { createTestWorkspace, PY_CODE, assertPass, logPass } from "../_setup";
import * as fs from "node:fs";

export async function testIndexStatus(): Promise<void> {
	const ws = createTestWorkspace("index_status_");
	try {
		fs.writeFileSync(ws.calculatorPath, PY_CODE, "utf8");
		const searchIndex = new HybridSearchIndex(ws.tempDir, "lean");
		const status = searchIndex.getStatus();
		assertPass("isModelCached is a boolean", typeof status.isModelCached === "boolean", { status });
		logPass(`Embedder disk cache detection verified (isModelCached: ${status.isModelCached})!`);
	} finally {
		ws.cleanup();
	}
}
