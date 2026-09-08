import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { measureSession } from "./session_metrics";
import { logPass } from "../_setup";
import { run as runNavigationFeatureVerification } from "./navigation_feature_verification";

export async function run(): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-metrics-"));
	try {
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, [
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "code_search" }] } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "code_search", content: [{ type: "text", text: "[code_search mode=auto->preview; matches=2]\nsrc/a.rs:1-2\nfeedback/a.md:1-2" }] } }),
		].join("\n"));
		const metrics = measureSession(file);
		assert.equal(metrics.toolCalls.code_search, 1);
		assert.equal(metrics.toolOutputChars.code_search, 74);
		assert.deepEqual(metrics.codeSearchModes, ["[code_search mode=auto->preview; matches=2]"]);
		assert.equal(metrics.markdownResultLines, 1);
		assert.equal(metrics.totalOutputChars, 74);
		logPass("Session benchmark metrics parser verified!");
	await runNavigationFeatureVerification();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
