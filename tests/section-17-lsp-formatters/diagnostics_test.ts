import * as path from "node:path";
import { formatDiagnostics, LspDiagnosticSeverity } from "../../src/lsp";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testLspFormatterDiagnostics(): void {
	const ws = createTestWorkspace("lsp_fmt_diag_");
	try {
		const samplePath = path.resolve(ws.tempDir, "calculator.py");
		const mockDiags = [
			{
				range: { start: { line: 7, character: 4 }, end: { line: 7, character: 15 } },
				severity: LspDiagnosticSeverity.Error,
				message: "NameError: name 'subtotal' is not defined",
				source: "pylsp",
				code: "undefined-variable",
			},
		];
		const out = formatDiagnostics(mockDiags, samplePath, ws.tempDir);
		assertPass("Diagnostics output includes severity label", out.includes("Error") || out.includes("error"), { out });
		assertPass("Diagnostics output includes the message", out.includes("NameError") || out.includes("subtotal"), { out });
		logPass("LSP diagnostics formatter verified!");
	} finally {
		ws.cleanup();
	}
}
