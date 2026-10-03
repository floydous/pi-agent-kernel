import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerReadTool } from "../../src/tools/read_tool";
import { logPass } from "../_setup";

function registerRead(deps: any): any {
	const pi: any = {
		registerTool(tool: any) {
			pi.tool = tool;
		},
	};
	registerReadTool(pi, deps);
	return pi.tool;
}

function text(result: any): string {
	return result.content?.find((part: any) => part.type === "text")?.text || "";
}

async function hintFor(enableTools: boolean): Promise<string> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-hint-"));
	try {
		fs.writeFileSync(path.join(tempDir, "target.ts"), "export const alpha = 1;\n", "utf8");
		const read = registerRead({
			getSessionId: () => "hint-session",
			getConfig: () => ({
				safety: { enable_epistemic_guard: false },
				editing: { default_anchors: true, read_mode: "auto" },
				retrieval: { enable_tools: enableTools },
			}),
		});
		const result = await read.execute(
			"target",
			{ path: "target.ts", symbol: "definitelyNotHere" },
			undefined,
			undefined,
			{ cwd: tempDir },
		);
		return text(result);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Tool hints must never recommend a tool the model cannot call. ast_search is opt-in
 * (retrieval.enable_tools / PI_ENABLE_ALL_RETRIEVAL_TOOLS), so the default hint must
 * point at code_search instead.
 */
export async function run(): Promise<void> {
	const previousFlag = process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
	delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
	try {
		const defaultHint = await hintFor(false);
		assert.match(defaultHint, /Symbol 'definitelyNotHere' not found/, "reports the missing symbol");
		assert.doesNotMatch(defaultHint, /ast_search/, "must not recommend ast_search when it is not registered");
		assert.match(defaultHint, /code_search/, "must point at the always-registered code_search");

		const optInHint = await hintFor(true);
		assert.match(optInHint, /ast_search/, "mentions ast_search when the opt-in tools are enabled");

		logPass("Read tool hints only recommend tools that are actually registered!");
	} finally {
		if (previousFlag === undefined) delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
		else process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS = previousFlag;
	}
}

if (require.main === module) {
	void run();
}