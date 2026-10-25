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

		// Verify tool schema no longer exposes symbol or surrounding_lines
		const schemaProps = read.parameters?.properties || {};
		assert.equal("symbol" in schemaProps, false, "read tool schema must not expose 'symbol'");
		assert.equal("surrounding_lines" in schemaProps, false, "read tool schema must not expose 'surrounding_lines'");
		assert.ok("offset" in schemaProps, "read tool schema must expose 'offset'");
		assert.ok("limit" in schemaProps, "read tool schema must expose 'limit'");
		assert.ok("path" in schemaProps, "read tool schema must expose 'path'");

		const largePath = path.join(tempDir, "large.ts");
		fs.writeFileSync(
			largePath,
			Array.from({ length: 2200 }, (_, index) => `line-${index} ${"x".repeat(40)}`).join("\n"),
		);
		const capped = await read.execute("large", { path: "large.ts" }, undefined, undefined, ctx);
		const cappedText = text(capped);
		assert.equal(capped.isError, undefined);
		assert.equal(capped.details.truncated, true);
		assert.equal(capped.details.shownLines, 250, "unconstrained read on large file caps at default 250 lines");
		assert.ok(cappedText.startsWith("line-0 "), "ordinary broad reads are plain by default");
		assert.ok(!/^\s*1#[0-9A-F]{2}│/m.test(cappedText), "broad read does not pay anchor overhead by default");
		assert.match(cappedText, /Use offset=251 to continue\./);

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

		// Assert explicit limit overrides the 250-line default window up to MAX_READ_LINES
		const explicit = await read.execute("explicit", { path: "large.ts", limit: 600 }, undefined, undefined, ctx);
		assert.equal(explicit.details.shownLines, 600, "explicit limit overrides 250-line default window");
		assert.equal(explicit.details.truncated, true);
		assert.match(text(explicit), /Use offset=601 to continue\./);

		// Assert file below 250 lines is returned in full without truncation
		const smallPath = path.join(tempDir, "small.ts");
		fs.writeFileSync(smallPath, Array.from({ length: 120 }, (_, i) => `small-line-${i}`).join("\n"));
		const small = await read.execute("small", { path: "small.ts" }, undefined, undefined, ctx);
		assert.equal(small.details.shownLines, 120, "file under 250 lines is returned in full");
		assert.equal(small.details.truncated, false, "small file is not truncated");

		// Assert passing ignored legacy symbol and surrounding_lines arguments reads the file cleanly without throwing
		const legacy = await read.execute("legacy", { path: "small.ts", symbol: "arbitrarySymbol", surrounding_lines: 5 }, undefined, undefined, ctx);
		assert.equal(legacy.isError, undefined, "legacy symbol and surrounding_lines parameters do not cause error");
		assert.equal(legacy.details.shownLines, 120, "legacy symbol arguments read file contents normally");

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
