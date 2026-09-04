// Section 34: LSP Clean Diagnostic Format & Reference Filtering

import * as fs from "node:fs";
import * as path from "node:path";
import { registerLspTool } from "../src/tools/lsp_tool";
import { LspManager } from "../src/lsp";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("34. LSP Clean Diagnostics & Reference Filtering", async () => {
		const ws = createTestWorkspace();
		try {
			let registeredTool: any = null;
			const mockPi: any = {
				registerTool(tool: any) {
					if (tool.name === "lsp") registeredTool = tool;
				},
			};
			registerLspTool(mockPi);
			assertPass("LSP tool registered", !!registeredTool);

			// 1. Test Clean Diagnostics Output Format
			const cleanFilePath = path.join(ws.tempDir, "clean.py");
			fs.writeFileSync(cleanFilePath, "def clean_fn():\n    return 42\n", "utf8");

			const diagRes = await registeredTool.execute(
				"test-diag",
				{ action: "diagnostics", path: "clean.py" },
				undefined,
				() => {},
				{ cwd: ws.tempDir },
			);

			assertPass("Diagnostics executed cleanly", !diagRes.isError, { diagRes });
			const diagText = diagRes.content?.[0]?.text || "";
			assertPass(
				"Clean diagnostics returns concise '<path> clean' without filler words",
				diagText === "clean.py clean",
				{ diagText },
			);
			logPass("Clean diagnostics returns concise '<path> clean'!");

			// 2. Test Syntax Error Diagnostics (Non-clean)
			const errorFilePath = path.join(ws.tempDir, "broken.py");
			fs.writeFileSync(errorFilePath, "def broken(\n", "utf8");

			const errDiagRes = await registeredTool.execute(
				"test-diag-err",
				{ action: "diagnostics", path: "broken.py" },
				undefined,
				() => {},
				{ cwd: ws.tempDir },
			);
			const errText = errDiagRes.content?.[0]?.text || "";
			assertPass(
				"Syntax error returns formatted diagnostics without filler prefix",
				!errText.includes("Diagnostics for") &&
					errText.startsWith("- [") &&
					(errText.includes("invalid-syntax") || errText.includes("Syntax validation")),
				{ errText },
			);
			logPass("Syntax error correctly reported!");

			// 3. Test Reference Filtering (exclude_tests, exclude_declaration)
			const modPath = path.join(ws.tempDir, "mod.py");
			fs.writeFileSync(modPath, "def target_func():\n    return 1\n\nx = target_func()\n", "utf8");

			const testPath = path.join(ws.tempDir, "test_mod.py");
			fs.writeFileSync(testPath, "from mod import target_func\n\ndef test_target():\n    assert target_func() == 1\n", "utf8");

			const subDirTest = path.join(ws.tempDir, "tests");
			fs.mkdirSync(subDirTest, { recursive: true });
			fs.writeFileSync(path.join(subDirTest, "suite.py"), "from mod import target_func\ntarget_func()\n", "utf8");

			// Query without filters (baseline): all 4 call sites present
			const refResAll = await registeredTool.execute(
				"test-ref-all",
				{ action: "references", path: "mod.py", symbol: "target_func" },
				undefined,
				() => {},
				{ cwd: ws.tempDir },
			);
			const refAllText = refResAll.content?.[0]?.text || "";
			assertPass(
				"Baseline returns all references across source and tests",
				refAllText.includes("mod.py") &&
					refAllText.includes("test_mod.py") &&
					refAllText.includes("suite.py"),
				{ refAllText },
			);

			// Query references with exclude_tests: true
			const refResExTest = await registeredTool.execute(
				"test-ref-ex-test",
				{
					action: "references",
					path: "mod.py",
					symbol: "target_func",
					exclude_tests: true,
				},
				undefined,
				() => {},
				{ cwd: ws.tempDir },
			);
			const refExTestText = refResExTest.content?.[0]?.text || "";
			assertPass(
				"exclude_tests filters out test files and test directories",
				!refExTestText.includes("test_mod.py") &&
					!refExTestText.includes("tests") &&
					refExTestText.includes("mod.py"),
				{ refExTestText },
			);

			// Query references with exclude_declaration: true
			const refResExDecl = await registeredTool.execute(
				"test-ref-ex-decl",
				{
					action: "references",
					path: "mod.py",
					symbol: "target_func",
					exclude_declaration: true,
				},
				undefined,
				() => {},
				{ cwd: ws.tempDir },
			);
			const refExDeclText = refResExDecl.content?.[0]?.text || "";
			assertPass(
				"exclude_declaration filters out declaration line",
				!refExDeclText.includes("mod.py:1:5") && refExDeclText.includes("mod.py:4:5"),
				{ refExDeclText },
			);

			// Query with both exclude_tests and exclude_declaration: only production callers remain
			const refResProdOnly = await registeredTool.execute(
				"test-ref-prod-only",
				{
					action: "references",
					path: "mod.py",
					symbol: "target_func",
					exclude_tests: true,
					exclude_declaration: true,
				},
				undefined,
				() => {},
				{ cwd: ws.tempDir },
			);
			const refProdOnlyText = refResProdOnly.content?.[0]?.text || "";
			assertPass(
				"Combined filters isolate only production call sites",
				refProdOnlyText.startsWith("mod.py:4:5:"),
				{ refProdOnlyText },
			);
			logPass("Reference filtering options (exclude_tests, exclude_declaration, combined) verified!");
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
