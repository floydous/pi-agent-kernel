import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { assertPass, logPass } from "../_setup";

export function testHybridAuthorization(): void {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-guard-test-"));
	const testFile = path.join(tempDir, "service.ts");

	try {
		const content = [
			'import { Router } from "express";',
			'import { Logger } from "./logger";',
		];
		for (let i = 3; i < 500; i++) {
			content.push(`// Line ${i}: generic service method`);
		}
		content.push("export function handleStart() {");
		content.push("  Logger.info('Starting');");
		content.push("}");
		fs.writeFileSync(testFile, content.join("\n"), "utf8");

		const guard = new EpistemicGuard();
		const session = "hybrid-test-session";

		// 1. Agent only observed lines 490-505 (handleStart)
		guard.recordFileRead(testFile, session, tempDir, undefined, {
			coverage: { complete: false, ranges: [{ startLine: 490, endLine: 502 }], totalLines: 502 },
			provenance: "read",
		});

		// Block 1: lines 500-502 (covered by visible read - Tier 1)
		const range1 = { startLine: 500, endLine: 502 };
		const search1 = "export function handleStart() {\n  Logger.info('Starting');\n}";

		// Block 2: lines 1-2 (substantive 2-line anchor at top of file - Tier 2)
		const range2 = { startLine: 1, endLine: 2 };
		const search2 = 'import { Router } from "express";\nimport { Logger } from "./logger";';

		const hybridRes = guard.checkReadPrecondition(
			testFile,
			"edit",
			session,
			tempDir,
			true,
			[range1, range2],
			[search1, search2]
		);

		assertPass(
			"Per-block hybrid authorization allows mixed Tier 1 read + Tier 2 anchored blocks",
			hybridRes.allowed === true && hybridRes.tier === 2,
			{ hybridRes }
		);

		// Block 3: non-substantive 1-line unobserved block without anchors should be rejected with targeted hint
		const range3 = { startLine: 1, endLine: 1 };
		const search3 = 'import { Router } from "express";';

		const failRes = guard.checkReadPrecondition(
			testFile,
			"edit",
			session,
			tempDir,
			true,
			[range1, range3],
			[search1, search3]
		);

		assertPass(
			"Unobserved non-substantive block fails closed with targeted read suggestion",
			failRes.allowed === false && (failRes.reason || "").includes('read({ path: "service.ts", offset: 1'),
			{ failRes }
		);

		// Edge case: malformed / out-of-bounds range beyond EOF must fail closed
		const badRange = { startLine: 600, endLine: 650 };
		const badRes = guard.checkReadPrecondition(
			testFile,
			"edit",
			session,
			tempDir,
			true,
			[badRange],
			['some text exceeding 35 chars in non-empty line\nsecond line']
		);
		assertPass(
			"Out-of-bounds target range beyond EOF fails closed",
			badRes.allowed === false && (badRes.reason || "").includes("Malformed or out-of-bounds"),
			{ badRes }
		);

		// Single long line (>50 chars) without visible read must be strictly rejected (no 1-line loophole)
		const longSingleLine = "const veryLongUnreadSingleLineConfigurationVariable = true;";
		const longSingleLineRange = { startLine: 1, endLine: 1 };
		const singleLineRes = guard.checkReadPrecondition(
			testFile,
			"edit",
			session,
			tempDir,
			true,
			[range1, longSingleLineRange],
			[search1, longSingleLine]
		);
		assertPass(
			"Single unread line >50 chars is rejected; multi-line context required",
			singleLineRes.allowed === false && (singleLineRes.reason || "").includes("<2 lines / <35 chars"),
			{ singleLineRes }
		);

		// Single line with trailing newlines only ("line\n") must NOT count as 2 substantive lines
		const trailingNewlineBlock = "const singleLineWithTrailingNewlineOnly = 1234567890;\n\n";
		const trailingRes = guard.checkReadPrecondition(
			testFile,
			"edit",
			session,
			tempDir,
			true,
			[range1, longSingleLineRange],
			[search1, trailingNewlineBlock]
		);
		assertPass(
			"Single line with trailing newline only fails closed (not multi-line)",
			trailingRes.allowed === false && (trailingRes.reason || "").includes("<2 lines / <35 chars"),
			{ trailingRes }
		);

		// Two short lines padded with blank lines/whitespace to >35 raw chars must fail closed
		const paddedShortLines = "x\ny\n\n                             ";
		const paddedRes = guard.checkReadPrecondition(
			testFile,
			"edit",
			session,
			tempDir,
			true,
			[range1, longSingleLineRange],
			[search1, paddedShortLines]
		);
		assertPass(
			"Two short lines padded with whitespace fail closed (<35 substantive chars)",
			paddedRes.allowed === false && (paddedRes.reason || "").includes("<2 lines / <35 chars"),
			{ paddedRes }
		);

		logPass("Per-block hybrid authorization verified!");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}
