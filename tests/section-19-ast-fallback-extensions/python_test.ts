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

		const localHover = extractLocalSymbolHover(samplePath, 7, 15, "subtotal");
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
			"searchAstSymbols reports enclosing symbol end line",
			spanHits.some((s) => s.name === "calculate_tax" && s.endLine === 9),
			{ spanHits },
		);

		logPass("Python AST fallback extensions passed!");
	} finally {
		ws.cleanup();
	}
}
