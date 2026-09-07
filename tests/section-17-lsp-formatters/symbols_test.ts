import * as path from "node:path";
import { formatDocumentSymbols, LspSymbolKind } from "../../src/lsp";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testLspFormatterSymbols(): void {
	const ws = createTestWorkspace("lsp_fmt_sym_");
	try {
		const samplePath = path.resolve(ws.tempDir, "calculator.py");
		const mockSymbols = [
			{ name: "Calculator", kind: LspSymbolKind.Class, range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, children: [] },
			{ name: "calculate_tax", kind: LspSymbolKind.Method, range: { start: { line: 4, character: 0 }, end: { line: 6, character: 0 } }, selectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, children: [] },
		];
		const out = formatDocumentSymbols(mockSymbols);
		assertPass("Document symbols formatter includes 'Calculator'", out.includes("Calculator"), { out });
		assertPass("Document symbols formatter includes 'calculate_tax'", out.includes("calculate_tax"), { out });
		logPass("LSP document symbols formatter verified!");
	} finally {
		ws.cleanup();
	}
}
