import * as path from "node:path";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
	searchAstSymbols,
} from "../../src/retrieval/ast_search";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testPythonAstExtensions(): void {
	const ws = createTestWorkspace("fallback_py_");
	try {
		const samplePath = path.resolve(ws.tempDir, "calculator.py");

		const docSyms = extractDocumentSymbols(samplePath);
		assertPass(
			"extractDocumentSymbols finds Calculator",
			docSyms.some((s) => s.name === "Calculator"),
			{ docSyms },
		);
		assertPass(
			"extractDocumentSymbols has nested methods",
			docSyms.some((s) => s.name === "__init__" || s.name === "calculate_tax"),
			{ docSyms },
		);

		const symbolRefs = findSymbolReferences(ws.tempDir, "calculate_tax");
		assertPass(
			"findSymbolReferences finds calculate_tax",
			symbolRefs.length > 0,
			{ symbolRefs },
		);

		// The realistic fixture has calculate_tax starting at line 41
		const localHover = extractLocalSymbolHover(samplePath, 42, 30, "subtotal");
		assertPass(
			"extractLocalSymbolHover for parameter subtotal",
			!!localHover && localHover.includes("subtotal"),
			{ localHover },
		);

		const spanHits = searchAstSymbols(ws.tempDir, {
			name: "calculate_tax",
			exactMatch: true,
		});
		assertPass(
			"searchAstSymbols finds calculate_tax with an endLine >= startLine",
			spanHits.some((s) => s.name === "calculate_tax" && !!s.endLine && s.endLine >= s.line),
			{ spanHits }
		);

		logPass("Python AST fallback extensions passed!");
	} finally {
		ws.cleanup();
	}
}
