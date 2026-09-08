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

export async function testBareSymbolDefinition(): Promise<void> {
	const ws = createTestWorkspace("lsp_bare_sym_");
	try {
		const tool = registerLsp();
		const ctx = { cwd: ws.tempDir };

		// File A has unique symbol UniqueAlpha
		fs.writeFileSync(
			path.join(ws.tempDir, "alpha.ts"),
			"export class UniqueAlpha {\n  public run(): void {}\n}\n",
			"utf8",
		);

		// File B has duplicate symbol SharedGamma
		fs.writeFileSync(
			path.join(ws.tempDir, "beta.ts"),
			"export function SharedGamma(): number {\n  return 1;\n}\n",
			"utf8",
		);

		// File C also has duplicate symbol SharedGamma
		fs.writeFileSync(
			path.join(ws.tempDir, "gamma.py"),
			"def SharedGamma():\n    return 2\n",
			"utf8",
		);

		// 1. Unique match without path
		const uniqueRes = await tool.execute(
			"bare-unique",
			{ action: "definition", symbol: "UniqueAlpha" },
			undefined,
			undefined,
			ctx,
		);
		const uniqueText = uniqueRes.content?.[0]?.text || "";
		assertPass("Unique bare-symbol lookup succeeds", !uniqueRes.isError, { uniqueRes });
		assertPass("Unique match indicates unique match", uniqueText.includes("unique match for 'UniqueAlpha'"), { uniqueText });
		assertPass("Unique match points to alpha.ts", uniqueText.includes("alpha.ts"), { uniqueText });
		assertPass("Unique match has class kind", uniqueText.includes("[class] UniqueAlpha"), { uniqueText });
		assertPass("Details has source tree-sitter", uniqueRes.details?.source === "tree-sitter", { details: uniqueRes.details });
		assertPass("Details count is 1", uniqueRes.details?.count === 1, { details: uniqueRes.details });

		// 2. Ambiguous match without path
		const ambigRes = await tool.execute(
			"bare-ambig",
			{ action: "definition", symbol: "SharedGamma" },
			undefined,
			undefined,
			ctx,
		);
		const ambigText = ambigRes.content?.[0]?.text || "";
		assertPass("Ambiguous bare-symbol lookup succeeds", !ambigRes.isError, { ambigRes });
		assertPass("Ambiguous match indicates multiple matches", ambigText.includes("matches for 'SharedGamma'"), { ambigText });
		assertPass("Ambiguous match mentions beta.ts", ambigText.includes("beta.ts"), { ambigText });
		assertPass("Ambiguous match mentions gamma.py", ambigText.includes("gamma.py"), { ambigText });
		assertPass("Details count is 2", ambigRes.details?.count === 2, { details: ambigRes.details });

		// 3. Missing symbol without path
		const missingRes = await tool.execute(
			"bare-missing",
			{ action: "definition", symbol: "NonExistentZeta" },
			undefined,
			undefined,
			ctx,
		);
		const missingText = missingRes.content?.[0]?.text || "";
		assertPass("Missing bare-symbol lookup succeeds without crash", !missingRes.isError, { missingRes });
		assertPass("Missing match returns clean not-found message", missingText.includes("Definition not found for symbol 'NonExistentZeta' in workspace."), { missingText });
		assertPass("Details count is 0", missingRes.details?.count === 0, { details: missingRes.details });

		// 4. Missing path on other actions returns controlled error
		const refsNoPath = await tool.execute(
			"refs-no-path",
			{ action: "references", symbol: "UniqueAlpha" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("References requires path", refsNoPath.isError === true, { refsNoPath });
		assertPass("References error message mentions path required", (refsNoPath.content?.[0]?.text || "").includes("'path' is required"), { refsNoPath });

		// 5. Definition without path and without symbol returns controlled error
		const defNoPathNoSym = await tool.execute(
			"def-no-path-no-sym",
			{ action: "definition" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Definition without path or symbol returns error", defNoPathNoSym.isError === true, { defNoPathNoSym });
		assertPass("Definition error mentions symbol is required", (defNoPathNoSym.content?.[0]?.text || "").includes("'symbol' is required"), { defNoPathNoSym });

		logPass("Bare-symbol definition lookup verified!");
	} finally {
		ws.cleanup();
	}
}
