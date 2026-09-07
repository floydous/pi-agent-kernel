import * as fs from "node:fs";
import * as path from "node:path";
import { registerLspTool } from "../../src/tools/lsp_tool";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testLspCleanDiagnostics(): Promise<void> {
	const ws = createTestWorkspace("lsp_diag_");
	try {
		const mockPi: any = {
			registerTool(tool: any) {
				if (tool.name === "lsp") (mockPi as any).lspTool = tool;
			},
		};
		registerLspTool(mockPi);
		const registeredTool: any = (mockPi as any).lspTool;
		assertPass("LSP tool registered", !!registeredTool, {});

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
		assertPass("Clean diagnostics text contains 'clean' status indicator", diagText.includes("clean"), { diagText });

		logPass("LSP clean diagnostics formatting verified!");
	} finally {
		ws.cleanup();
	}
}
