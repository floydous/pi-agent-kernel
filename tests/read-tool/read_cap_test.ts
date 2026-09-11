import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerReadTool } from "../../src/tools/read_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";
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

export async function run(): Promise<void> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-cap-"));
	const sessionId = `read-cap-${path.basename(tempDir)}`;
	globalEpistemicGuard.resetSession(sessionId);
	try {
		const config = {
			safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
			editing: { default_anchors: true, read_mode: "auto" },
		};
		const read = registerRead({
			getSessionId: () => sessionId,
			getConfig: () => config,
		});
		const ctx = { cwd: tempDir };

		const largePath = path.join(tempDir, "large.ts");
		fs.writeFileSync(
			largePath,
			Array.from({ length: 2200 }, (_, index) => `line-${index} ${"x".repeat(40)}`).join("\n"),
		);
		const capped = await read.execute("large", { path: "large.ts" }, undefined, undefined, ctx);
		const cappedText = text(capped);
		assert.equal(capped.isError, undefined);
		assert.equal(capped.details.truncated, true);
		assert.ok(capped.details.shownLines > 0 && capped.details.shownLines <= 2000);
		assert.ok(cappedText.startsWith("line-0 "), "ordinary broad reads are plain by default");
		assert.ok(!/^\s*1#[0-9A-F]{2}│/m.test(cappedText), "broad read does not pay anchor overhead by default");
		assert.match(cappedText, new RegExp(`Use offset=${capped.details.shownLines + 1} to continue\\.`));

		const evidence = globalEpistemicGuard.getEvidence(largePath, sessionId, tempDir);
		assert.ok(evidence);
		assert.equal(evidence.coverage.complete, false);
		assert.equal(evidence.coverage.ranges[0]?.startLine, 1);
		assert.equal(evidence.coverage.ranges[0]?.endLine, capped.details.shownLines);
		assert.equal(
			globalEpistemicGuard.checkReadPrecondition(
				largePath,
				"edit",
				sessionId,
				tempDir,
				true,
				[{ startLine: 2200, endLine: 2200 }],
			).allowed,
			false,
			"hidden lines are not authorized by a capped read",
		);

		const anchored = await read.execute(
			"anchored",
			{ path: "large.ts", offset: 1, limit: 2, anchors: true },
			undefined,
			undefined,
			ctx,
		);
		assert.match(text(anchored), /1#[0-9A-F]{2}│line-0/);
		assert.match(text(anchored), /2#[0-9A-F]{2}│line-1/);

		const hugePath = path.join(tempDir, "huge.ts");
		fs.writeFileSync(hugePath, `${"x".repeat(50 * 1024 + 1)}\nsmall`);
		const huge = await read.execute("huge", { path: "huge.ts" }, undefined, undefined, ctx);
		assert.equal(huge.details.shownLines, 0);
		assert.match(text(huge), /Line 1 is .*exceeds .* limit/);
		assert.deepEqual(globalEpistemicGuard.getEvidence(hugePath, sessionId, tempDir)?.coverage.ranges, []);

		logPass("Capped plain/anchored reads, continuation hints, oversized lines, and coverage authorization verified!");
	} finally {
		globalEpistemicGuard.resetSession(sessionId);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}
