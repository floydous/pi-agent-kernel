import * as fs from "node:fs";
import { chunkFile } from "../../src/retrieval/search_chunker";
import { createTestWorkspace, PY_CODE, assertPass, logPass } from "../_setup";

export function testChunking(): void {
	const ws = createTestWorkspace("chunk_py_");
	try {
		fs.writeFileSync(ws.calculatorPath, PY_CODE, "utf8");
		const chunks = chunkFile(ws.tempDir, ws.calculatorPath);
		assertPass("AST chunking produces at least one chunk", chunks.length > 0, { chunks });
		assertPass("AST chunk has breadcrumb containing the file name", chunks[0].breadcrumb.includes("calculator.py"), { chunks });
		logPass(`AST chunking verified (found ${chunks.length} chunk(s) with breadcrumbs)!`);
	} finally {
		ws.cleanup();
	}
}
