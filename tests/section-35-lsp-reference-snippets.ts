// Section 35: LSP Reference Snippets, Seam Verification & Epistemic Boundaries

import * as fs from "node:fs";
import * as path from "node:path";
import { registerLspTool } from "../src/tools/lsp_tool";
import { windowAround, formatReferences, pathToUri, LspManager } from "../src/lsp";
import { globalEpistemicGuard, resolveUserPath } from "../src/safety/epistemic_guard";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("35. LSP Reference Snippets & Seam Tests", async () => {
		const ws = createTestWorkspace();
		try {
			// 1. Test Windowing Algorithm for Long Symbol at Column Boundary (Anti-Truncation)
			// A 32-character symbol starting at column 30 on an 80-char line
			const longSym = "SuperLongDescriptiveFunctionName";
			const sampleLine = "const prefix_val = some_object." + longSym + "({ option: 1 });";
			const startCol0 = sampleLine.indexOf(longSym);
			const endCol0 = startCol0 + longSym.length;

			const snippet = windowAround(sampleLine, startCol0, endCol0, 50);
			assertPass(
				"Long identifier is never truncated off-screen in snippet",
				snippet.includes(longSym),
				{ snippet, longSym, startCol0, endCol0 },
			);
			assertPass(
				"Snippet is bounded and formatted with ellipsis if truncated at edge",
				snippet.startsWith("... ") || snippet.endsWith(" ...") || snippet.length <= 60,
				{ snippet, length: snippet.length },
			);
			logPass("Anti-truncation snippet windowing verified!");

			// 2. 0-based vs 1-based Seam Test
			// Test column 0 (line start) and column 40
			const lineCol0 = "def foo(): pass";
			const snipCol0 = windowAround(lineCol0, 0, 3, 50);
			assertPass(
				"Column 0 match is captured correctly without leading ellipsis",
				snipCol0.startsWith("def") && !snipCol0.startsWith("..."),
				{ snipCol0 },
			);

			// Test formatReferences with synthetic LSP 0-indexed ranges
			const refFilePath = path.join(ws.tempDir, "seam_check.py");
			fs.writeFileSync(refFilePath, "first_symbol = 10\nsecond_long_symbol_call = 20\n", "utf8");

			const formattedRefs = formatReferences(
				[
					{
						uri: pathToUri(refFilePath),
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 12 },
						},
					},
					{
						uri: pathToUri(refFilePath),
						range: {
							start: { line: 1, character: 0 },
							end: { line: 1, character: 23 },
						},
					},
				],
				ws.tempDir,
			);

			assertPass(
				"0-based LSP range converts to 1-based coordinates and attaches snippet",
				formattedRefs.includes("seam_check.py:1:1: first_symbol = 10") &&
					formattedRefs.includes("seam_check.py:2:1: second_long_symbol_call = 20"),
				{ formattedRefs },
			);
			logPass("0-based to 1-based indexing seam verified!");

			// 3. Epistemic Ledger Untouched Test (Security boundary)
			// Calling references must NEVER count as read evidence or authorize edits
			let registeredTool: any = null;
			const mockPi: any = {
				registerTool(tool: any) {
					if (tool.name === "lsp") registeredTool = tool;
				},
			};
			registerLspTool(mockPi);

			const targetFile = path.join(ws.tempDir, "unauthorized.py");
			fs.writeFileSync(
				targetFile,
				"def secret_handler():\n    return 'secret'\n\nx = secret_handler()\n",
				"utf8",
			);

			const resolvedTarget = resolveUserPath(targetFile, ws.tempDir);
			const TEST_SESSION = "__test_session_snippets_35__";

			const evidenceBefore = globalEpistemicGuard.getEvidence(
				resolvedTarget,
				TEST_SESSION,
				ws.tempDir,
			);
			assertPass("File starts with zero read evidence in epistemic guard", evidenceBefore === null, {
				evidenceBefore,
			});

			// Execute lsp references
			const toolRes = await registeredTool.execute(
				"call-lsp-ref",
				{
					action: "references",
					path: "unauthorized.py",
					symbol: "secret_handler",
				},
				undefined,
				() => {},
				{ cwd: ws.tempDir, sessionManager: { getSessionId: () => TEST_SESSION } },
			);

			assertPass("LSP references returned snippet results", !toolRes.isError, { toolRes });

			// Verify Epistemic Guard ledger is completely untouched
			const evidenceAfter = globalEpistemicGuard.getEvidence(
				resolvedTarget,
				TEST_SESSION,
				ws.tempDir,
			);
			assertPass(
				"LSP references did NOT record read evidence in the epistemic guard",
				evidenceAfter === null,
				{ evidenceAfter },
			);

			// Verify attempt to edit file without an explicit read is blocked
			const check = globalEpistemicGuard.checkReadPrecondition(
				resolvedTarget,
				"edit",
				TEST_SESSION,
				ws.tempDir,
				true,
				[{ startLine: 1, endLine: 2 }],
			);
			assertPass(
				"Edit remains blocked because snippet previews do not authorize mutations",
				!check.allowed,
				{ check },
			);
			logPass("Epistemic Guard security boundary strictly preserved!");
		} finally {
			await LspManager.getInstance().stopAll();
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
