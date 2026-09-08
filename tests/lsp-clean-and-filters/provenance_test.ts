import * as fs from "node:fs";
import * as path from "node:path";
import { registerLspTool } from "../../src/tools/lsp_tool";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

function registerLsp(): any {
	const pi: any = {
		registerTool(tool: any) {
			if (tool.name === "lsp") pi.tool = tool;
		},
	};
	registerLspTool(pi);
	return pi.tool;
}

export async function testLspProvenanceAndDirectoryGuard(): Promise<void> {
	const ws = createTestWorkspace("lsp_provenance_");
	try {
		const tool = registerLsp();
		const filePath = path.join(ws.tempDir, "clean.py");
		fs.writeFileSync(filePath, "def clean_fn():\n    return 42\n", "utf8");
		const ctx = { cwd: ws.tempDir };

		const directory = await tool.execute(
			"directory",
			{ action: "diagnostics", path: "." },
			undefined,
			undefined,
			ctx,
		);
		const directoryText = directory.content?.[0]?.text || "";
		assertPass("Directory diagnostics is an error", directory.isError === true, { directory });
		assertPass("Directory diagnostics explains file-only input", /directory|file/i.test(directoryText), { directoryText });
		assertPass("Directory diagnostics does not expose EISDIR", !directoryText.includes("EISDIR"), { directoryText });

		const diagnostics = await tool.execute(
			"diagnostics",
			{ action: "diagnostics", path: "clean.py" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Diagnostics returns provenance details", diagnostics.details?.action === "diagnostics", { details: diagnostics.details });
		assertPass("Diagnostics source is explicit", ["lsp", "syntax-check"].includes(diagnostics.details?.source), { details: diagnostics.details });
		assertPass("Diagnostics status is explicit", typeof diagnostics.details?.status === "string", { details: diagnostics.details });

		const definition = await tool.execute(
			"definition",
			{ action: "definition", path: "clean.py", symbol: "clean_fn" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Definition returns provenance details", definition.details?.action === "definition", { details: definition.details });
		assertPass("Definition source is explicit", ["lsp", "tree-sitter"].includes(definition.details?.source), { details: definition.details });

		const references = await tool.execute(
			"references",
			{ action: "references", path: "clean.py", symbol: "clean_fn" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("References returns provenance details", references.details?.action === "references", { details: references.details });
		assertPass("References source is explicit", ["lsp", "tree-sitter"].includes(references.details?.source), { details: references.details });

		const hover = await tool.execute(
			"hover",
			{ action: "hover", path: "clean.py", symbol: "clean_fn" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Hover returns provenance details", hover.details?.action === "hover", { details: hover.details });
		assertPass("Hover source is explicit", ["lsp", "tree-sitter"].includes(hover.details?.source), { details: hover.details });

		const symbols = await tool.execute(
			"symbols",
			{ action: "document_symbols", path: "clean.py" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Document symbols returns provenance details", symbols.details?.action === "document_symbols", { details: symbols.details });
		assertPass("Document symbols source is explicit", ["lsp", "tree-sitter"].includes(symbols.details?.source), { details: symbols.details });

		logPass("LSP provenance and directory-guard tests passed!");
	} finally {
		ws.cleanup();
	}
}
