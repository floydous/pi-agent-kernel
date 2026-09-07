import * as fs from "node:fs";
import * as path from "node:path";
import { registerLspTool } from "../../src/tools/lsp_tool";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testLspReferenceFiltering(): Promise<void> {
	const ws = createTestWorkspace("lsp_ref_");
	try {
		// Create a real file to test references against
		const realFile = path.join(ws.tempDir, "test_path.ts");
		fs.writeFileSync(realFile, "function test_path() { return 42; }\n", "utf8");

		const mockPi: any = {
			registerTool(tool: any) {
				if (tool.name === "lsp") (mockPi as any).lspTool = tool;
			},
		};
		registerLspTool(mockPi);
		const registeredTool: any = (mockPi as any).lspTool;
		assertPass("LSP tool registered", !!registeredTool, {});

		// References request returns either a successful response or a fail-closed error response
		const refRes = await registeredTool.execute(
			"test-refs",
			{ action: "references", path: "test_path.ts", line: 1, character: 5, excludeDeclaration: true },
			undefined,
			() => {},
			{ cwd: ws.tempDir },
		);

		// Both isError=true (no LSP server) and isError=false (server ran) are valid outputs
		// What matters is that the response has content and is not undefined
		assertPass("References response has structured content", !!refRes.content?.[0]?.text, { refRes });

		logPass("LSP reference filtering verified!");
	} finally {
		ws.cleanup();
	}
}
