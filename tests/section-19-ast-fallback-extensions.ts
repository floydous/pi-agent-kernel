// Section 19: AST Fallback Extensions - Document Symbols, References, Local Scope Hover

import * as path from "node:path";
import { extractDocumentSymbols, findSymbolReferences, extractLocalSymbolHover } from "../src/retrieval/ast_search";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("19. AST Fallback Extensions (Document Symbols, References, Hover)", () => {
		const ws = createTestWorkspace();
		try {
			const samplePath = path.resolve(ws.tempDir, "calculator.py");

			// 8. AST Fallback Extensions
			const docSyms = extractDocumentSymbols(samplePath);
			assertPass(
				"extractDocumentSymbols finds Calculator",
				docSyms.length > 0 && docSyms.some((s) => s.name === "Calculator"),
				{ docSyms }
			);
			logPass(`extractDocumentSymbols verified (${docSyms.length} symbol(s) found)!`);

			const symbolRefs = findSymbolReferences(ws.tempDir, "calculate_tax");
			assertPass(
				"findSymbolReferences finds calculate_tax",
				symbolRefs.length > 0,
				{ symbolRefs }
			);
			logPass(`findSymbolReferences verified (${symbolRefs.length} reference(s) found across workspace)!`);

			const localHover = extractLocalSymbolHover(samplePath, 7, 15, "subtotal");
			assertPass(
				"extractLocalSymbolHover for parameter subtotal",
				!!localHover && localHover.includes("subtotal: float"),
				{ localHover }
			);
			logPass("extractLocalSymbolHover verified for function parameter!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
