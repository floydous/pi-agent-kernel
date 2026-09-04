// Section 17: LSP - Formatters for diagnostics, definitions, references, hover, document symbols

import * as path from "node:path";
import {
	formatDiagnostics,
	formatDefinitions,
	formatReferences,
	formatHover,
	formatDocumentSymbols,
	LspDiagnosticSeverity,
	LspSymbolKind,
} from "../src/lsp";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("17. LSP Formatters (Diagnostics, Definitions, References, Hover, Symbols)", () => {
		const ws = createTestWorkspace();
		try {
			const samplePath = path.resolve(ws.tempDir, "calculator.py");
			const sampleUri = `file://${samplePath.replace(/\\/g, "/")}`;

			// 3. Diagnostics Formatter
			const mockDiags = [
				{
					range: { start: { line: 7, character: 4 }, end: { line: 7, character: 15 } },
					severity: LspDiagnosticSeverity.Error,
					code: "unresolved-import",
					source: "ty",
					message: "Module 'foo' cannot be resolved",
				},
				{
					range: { start: { line: 12, character: 0 }, end: { line: 12, character: 5 } },
					severity: LspDiagnosticSeverity.Warning,
					source: "ruff",
					message: "Unused variable 'bar'",
				},
			];
			const formattedDiags = formatDiagnostics(mockDiags, samplePath, ws.tempDir);
			assertPass(
				"Diagnostics formatter output",
				formattedDiags.includes("- [8:5] [ERROR] [unresolved-import] Module 'foo' cannot be resolved (ty)") &&
					formattedDiags.includes("- [13:1] [WARN] Unused variable 'bar' (ruff)") &&
					!formattedDiags.includes("Diagnostics for"),
				{ formattedDiags }
			);
			logPass("LSP diagnostics formatter verified!");

			// 4. Definitions & References Formatter
			const mockLocs = [
				{
					uri: sampleUri,
					range: { start: { line: 3, character: 4 }, end: { line: 3, character: 12 } },
				},
			];
			const formattedDefs = formatDefinitions(mockLocs, ws.tempDir);
			const formattedRefs = formatReferences(mockLocs, ws.tempDir);
			assertPass(
				"Definitions/References formatting",
				formattedDefs.includes("calculator.py:4:5") && formattedRefs.includes("calculator.py:4:5"),
				{ formattedDefs, formattedRefs }
			);
			logPass("LSP definitions and references formatters verified!");

			// 5. Hover and Symbol Formatters
			const hoverText = formatHover({
				contents: {
					kind: "markdown",
					value: "```python\ndef calculate_tax(subtotal: float) -> float\n```\nCalculates 10% tax rate.",
				},
			});
			assertPass(
				"Hover formatting",
				hoverText.includes("calculate_tax") && hoverText.includes("10% tax rate"),
				{ hoverText }
			);

			const mockSymbols = [
				{
					name: "Calculator",
					kind: LspSymbolKind.Class,
					range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
					selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 16 } },
					children: [
						{
							name: "calculate_tax",
							kind: LspSymbolKind.Method,
							range: { start: { line: 3, character: 4 }, end: { line: 6, character: 0 } },
							selectionRange: { start: { line: 3, character: 8 }, end: { line: 3, character: 21 } },
						},
					],
				},
			];
			const formattedSyms = formatDocumentSymbols(mockSymbols);
			assertPass(
				"Document symbol hierarchy formatting",
				formattedSyms.includes("1: [class] Calculator") && formattedSyms.includes("4: [method] calculate_tax"),
				{ formattedSyms }
			);
			logPass("LSP hover and document symbol hierarchy formatters verified!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
