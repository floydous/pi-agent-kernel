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

async function hintFor(): Promise<string> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-hint-"));
	try {
		fs.writeFileSync(path.join(tempDir, "target.ts"), "export const alpha = 1;\n", "utf8");
		const read = registerRead({
			getSessionId: () => "hint-session",
			getConfig: () => ({
				safety: { enable_epistemic_guard: false },
				editing: { default_anchors: true, read_mode: "auto" },
				retrieval: {},
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
 * Tool hints must never recommend a deleted or unavailable tool. The read tool hint must
 * point at code_search.
 */
export async function run(): Promise<void> {
	const defaultHint = await hintFor();
	assert.match(defaultHint, /Symbol 'definitelyNotHere' not found/, "reports the missing symbol");
	assert.doesNotMatch(defaultHint, /ast_search/, "must not recommend ast_search");
	assert.match(defaultHint, /code_search/, "must point at code_search");

	logPass("Read tool hints consistently recommend available code_search tool!");
}

if (require.main === module) {
	void run();
}