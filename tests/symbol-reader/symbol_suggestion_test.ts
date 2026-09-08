import * as path from "node:path";
import * as assert from "node:assert";
import { registerReadTool } from "../../src/tools/read_tool";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

function register(registerer: (pi: any, deps?: any) => void, deps?: any): any {
	const pi: any = {
		registerTool(tool: any) {
			pi.tool = tool;
		},
	};
	registerer(pi, deps);
	return pi.tool;
}

export async function testSymbolSuggestions(): Promise<void> {
	const ws = createPolyglotWorkspace("sym_suggest_");
	try {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".ts", ".rs", ".go", ".java", ".py"]);

		const guard = new EpistemicGuard();
		const ctx = { cwd: ws.tempDir };
		const readTool = register(registerReadTool, {
			getSessionId: () => "test-session",
			getConfig: () => ({ safety: { enable_epistemic_guard: true } }),
		});

		// 1. Exact symbol read succeeds without suggestions
		const exactRes = await readTool.execute(
			"c1",
			{ path: "src/app.ts", symbol: "withConnection" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Exact symbol read succeeds", !exactRes.isError && exactRes.content?.[0]?.text?.includes("withConnection"), { exactRes });
		assertPass("Exact symbol output contains full body", exactRes.content[0].text.includes("protected release(): void") === false && exactRes.content[0].text.includes("async withConnection"), { text: exactRes.content[0].text });

		// 2. Typo symbol read fails (isError: true) and provides bounded suggestion
		const typoRes = await readTool.execute(
			"c2",
			{ path: "src/app.ts", symbol: "withConnectio" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Typo symbol read returns error", typoRes.isError === true, { typoRes });
		const typoText = typoRes.content[0].text;
		assertPass("Typo message states symbol not found", typoText.includes("Symbol 'withConnectio' not found in src/app.ts."), { typoText });
		assertPass("Typo message includes 'Did you mean:'", typoText.includes("Did you mean:"), { typoText });
		assertPass("Typo suggestion includes withConnection", typoText.includes("withConnection (src/app.ts:27) [method]"), { typoText });
		assertPass("Typo does NOT extract method body", !typoText.includes("const conn =") && !typoText.includes("return work(c)"), { typoText });

		// 3. Completely non-existent symbol returns no suggestions
		const noneRes = await readTool.execute(
			"c3",
			{ path: "src/app.ts", symbol: "completelyUnrelatedSymbolXyz" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Non-existent symbol returns error", noneRes.isError === true, { noneRes });
		const noneText = noneRes.content[0].text;
		assertPass("Non-existent symbol does not suggest random items", !noneText.includes("Did you mean:"), { noneText });
		assertPass("Non-existent symbol suggests ast_search/rg fallback", noneText.includes("Use 'ast_search' to locate symbols"), { noneText });

		// 4. Multiple candidates ranked properly (e.g. 'connect')
		const multiRes = await readTool.execute(
			"c4",
			{ path: "src/app.ts", symbol: "connect" },
			undefined,
			undefined,
			ctx,
		);
		assertPass("Prefix/partial symbol returns error", multiRes.isError === true, { multiRes });
		const multiText = multiRes.content[0].text;
		assertPass("Partial symbol suggests candidates", multiText.includes("Did you mean:"), { multiText });
		assertPass("Suggestions contain connectInternal or withConnection", multiText.includes("connectInternal") || multiText.includes("withConnection"), { multiText });
		const candidateCount = (multiText.match(/^- /gm) || []).length;
		assertPass("Suggestions are bounded to at most 3", candidateCount > 0 && candidateCount <= 3, { candidateCount, multiText });

		// 5. Failed typo read must NOT authorize an edit in epistemic guard
		const targetFile = path.join(ws.tempDir, "src/app.ts");
		const authCheck = guard.checkReadPrecondition(targetFile, "edit", "test-session", ws.tempDir, true, [{ startLine: 27, endLine: 35 }]);
		assertPass("Failed symbol read did not authorize editing", authCheck.allowed === false, { authCheck });

		logPass("Symbol suggestions unit tests passed!");
	} finally {
		ws.cleanup();
	}
}
