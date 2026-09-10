import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	EpistemicGuard,
	parseGrepOutput,
	parsePagingAndDiffOutput,
	linesToRanges,
} from "../../src/safety/epistemic_guard";
import { preflightSurgicalPatchBlock } from "../../src/editing/patch";
import { assertPass, logPass } from "../_setup";

export function testMultiChannelStressMatrix(): void {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "epistemic-prod-matrix-"));

	function createSourceFile(relPath: string, lineCount = 500): string {
		const absPath = path.join(tmpDir, relPath);
		fs.mkdirSync(path.dirname(absPath), { recursive: true });
		const lines: string[] = [];
		for (let i = 1; i <= lineCount; i++) {
			if (i === 10) {
				lines.push("export const CONFIG_HEADER = true;");
			} else if (i === 120) {
				lines.push("export function calculateTax(income: number) {");
			} else if (i === 125) {
				lines.push("  const rate = 0.25;");
			} else if (i === 130) {
				lines.push("  return income * rate;");
			} else if (i === 135) {
				lines.push("}");
			} else if (i === 288) {
				lines.push("    inst._zod.onattach.push((inst) => {");
			} else if (i === 289) {
				lines.push("      const bag = inst._zod.bag;");
			} else if (i === 290) {
				lines.push("      bag.format = def.format;");
			} else if (i === 291) {
				lines.push("      bag.minimum = minimum;");
			} else if (i === 292) {
				lines.push("      bag.maximum = maximum;");
			} else if (i === 293) {
				lines.push("    });");
			} else if (i === 350) {
				lines.push("  return Boolean(val);");
			} else if (i === 418) {
				lines.push("    inst._zod.bigint.format = def.format;");
			} else if (i === 419) {
				lines.push("    inst._zod.bigint.minimum = minimum;");
			} else {
				lines.push(`// Line ${i}: generic statement or comment in file`);
			}
		}
		fs.writeFileSync(absPath, lines.join("\n"), "utf8");
		return absPath;
	}

	try {
		const checksFile = createSourceFile("packages/zod/src/v4/core/checks.ts", 500);
		const helperFile = createSourceFile("packages/zod/src/v4/core/util.ts", 300);
		const isolatedFile = createSourceFile("packages/zod/src/v4/core/isolated.ts", 100);
		const secretFile = createSourceFile("secrets.env", 20);

		const guard = new EpistemicGuard();
		const session = "stress-session-main";

		// SECTION A: SHELL SEARCH OBSERVATION
		// Test 1: grep -n single file
		const grep1 = `
288:    inst._zod.onattach.push((inst) => {
289:      const bag = inst._zod.bag;
290:      bag.format = def.format;
291:      bag.minimum = minimum;
292:      bag.maximum = maximum;
293:    });`;
		guard.recordCommandExecution(
			"grep -n 'onattach' packages/zod/src/v4/core/checks.ts",
			tmpDir,
			session,
			true,
			grep1,
		);
		const rec1 = guard.getEvidence(checksFile, session, tmpDir);
		assertPass(
			"Exact line range [288, 293] captured from grep -n",
			rec1 !== null && rec1.coverage.ranges.some((r) => r.startLine === 288 && r.endLine === 293),
			{ rec1 },
		);

		// Test 2: ripgrep with context lines
		const rgContext = `
123-export function calculateTax(income: number) {
124-// Line 124
125:  const rate = 0.25;
126-// Line 126
127-  return income * rate;
`;
		guard.recordCommandExecution(
			"rg -C 2 'const rate' packages/zod/src/v4/core/checks.ts",
			tmpDir,
			session,
			true,
			rgContext,
		);
		const rec2 = guard.getEvidence(checksFile, session, tmpDir);
		assertPass(
			"Ripgrep context dash delimiters parsed and merged",
			rec2 !== null && rec2.coverage.ranges.some((r) => r.startLine === 123 && r.endLine === 127),
			{ rec2 },
		);

		// Test 3: Multi-file grep
		const multiGrep = `
packages/zod/src/v4/core/checks.ts:350:  return Boolean(val);
packages/zod/src/v4/core/util.ts:10:export const CONFIG_HEADER = true;
`;
		guard.recordCommandExecution(
			"grep -rn 'return Boolean' packages/zod/src/",
			tmpDir,
			session,
			true,
			multiGrep,
		);
		const recChecks = guard.getEvidence(checksFile, session, tmpDir);
		const recUtil = guard.getEvidence(helperFile, session, tmpDir);
		assertPass(
			"Multi-file lines segregated cleanly without cross-file contamination",
			recChecks !== null &&
				recChecks.coverage.ranges.some((r) => r.startLine <= 350 && r.endLine >= 350) &&
				recUtil !== null &&
				recUtil.coverage.ranges.some((r) => r.startLine <= 10 && r.endLine >= 10),
			{ recChecks, recUtil },
		);

		// SECTION B: SHELL PAGING OBSERVATION
		// Test 4: head -n 25
		guard.recordCommandExecution("head -n 25 packages/zod/src/v4/core/isolated.ts", tmpDir, session, true, "...");
		const recIso4 = guard.getEvidence(isolatedFile, session, tmpDir);
		assertPass(
			"head -n 25 records range [1, 25]",
			recIso4 !== null && recIso4.coverage.ranges.some((r) => r.startLine === 1 && r.endLine === 25),
			{ recIso4 },
		);

		// Test 5: tail -n 20
		guard.recordCommandExecution("tail -n 20 packages/zod/src/v4/core/isolated.ts", tmpDir, session, true, "...");
		const recIso5 = guard.getEvidence(isolatedFile, session, tmpDir);
		assertPass(
			"tail -n 20 records range [81, 100]",
			recIso5 !== null && recIso5.coverage.ranges.some((r) => r.startLine === 81 && r.endLine === 100),
			{ recIso5 },
		);

		// Test 6: sed -n '40,60p'
		guard.recordCommandExecution(
			"sed -n '40,60p' packages/zod/src/v4/core/isolated.ts",
			tmpDir,
			session,
			true,
			"...",
		);
		const recIso6 = guard.getEvidence(isolatedFile, session, tmpDir);
		assertPass(
			"sed -n '40,60p' records range [40, 60]",
			recIso6 !== null && recIso6.coverage.ranges.some((r) => r.startLine === 40 && r.endLine === 60),
			{ recIso6 },
		);

		// SECTION C: COMPILER & STACK TRACE EXTRACTION
		// Test 7: Rust compiler error
		const rustTrace = "error[E0063]: missing field `maximum`\n --> packages/zod/src/v4/core/checks.ts:418:9";
		guard.recordCommandExecution("cargo test", tmpDir, session, false, rustTrace);
		const recTrace7 = guard.getEvidence(checksFile, session, tmpDir);
		assertPass(
			"Rust compiler error line 418 captured with context window",
			recTrace7 !== null && recTrace7.coverage.ranges.some((r) => r.startLine <= 418 && r.endLine >= 418),
			{ recTrace7 },
		);

		// Test 8: Vitest stack trace
		const vitestTrace = "FAIL packages/zod/src/v4/core/util.ts\n ❯ packages/zod/src/v4/core/util.ts:125:15";
		guard.recordCommandExecution("pnpm test", tmpDir, session, false, vitestTrace);
		const recVitest8 = guard.getEvidence(helperFile, session, tmpDir);
		assertPass(
			"Vitest stack trace line 125 captured with context window",
			recVitest8 !== null && recVitest8.coverage.ranges.some((r) => r.startLine <= 125 && r.endLine >= 125),
			{ recVitest8 },
		);

		// Test 9: Python traceback
		const pyTrace = 'File "packages/zod/src/v4/core/util.ts", line 200, in test_util';
		guard.recordCommandExecution("pytest", tmpDir, session, false, pyTrace);
		const recPy9 = guard.getEvidence(helperFile, session, tmpDir);
		assertPass(
			"Python stack trace line 200 captured with context window",
			recPy9 !== null && recPy9.coverage.ranges.some((r) => r.startLine <= 200 && r.endLine >= 200),
			{ recPy9 },
		);

		// SECTION D: DUAL-TIER AUTHORIZATION
		// Test 10: Tier 1 exact range coverage on lines 289-292
		const zodEdit10 = `      const bag = inst._zod.bag;
      bag.format = def.format;
      bag.minimum = minimum;
      bag.maximum = maximum;`;
		const pre10 = preflightSurgicalPatchBlock(checksFile, zodEdit10);
		assertPass("Preflight locates zodEdit10 uniquely", pre10.success && pre10.targetRange !== undefined, {
			pre10,
		});

		const res10 = guard.checkReadPrecondition(
			checksFile,
			"edit",
			session,
			tmpDir,
			true,
			pre10.targetRange ? [pre10.targetRange] : [],
			[zodEdit10],
		);
		assertPass(
			"Tier 1 edit inside observed ranges [288, 293] is authorized",
			res10.allowed && res10.tier === 1,
			{ res10 },
		);

		// Test 11: Tier 2 substantive unique block (unobserved lines 10-12)
		const substantive11 = `// Line 9: generic statement or comment in file
export const CONFIG_HEADER = true;
// Line 11: generic statement or comment in file`;
		const pre11 = preflightSurgicalPatchBlock(checksFile, substantive11);
		const res11 = guard.checkReadPrecondition(
			checksFile,
			"edit",
			session,
			tmpDir,
			true,
			pre11.targetRange ? [pre11.targetRange] : [],
			[substantive11],
		);
		assertPass(
			"Tier 2 substantive unique block without read is authorized",
			res11.allowed && res11.tier === 2,
			{ res11 },
		);

		// Test 12: Negative - Blind 1-line guess on unobserved range blocked
		const blind12 = "// Line 490: generic statement or comment in file";
		const pre12 = preflightSurgicalPatchBlock(checksFile, blind12);
		const res12 = guard.checkReadPrecondition(
			checksFile,
			"edit",
			session,
			tmpDir,
			true,
			pre12.targetRange ? [pre12.targetRange] : [],
			[blind12],
		);
		assertPass(
			"Blind 1-line guess on unobserved range is blocked",
			!res12.allowed && (res12.reason || "").includes("non-substantive"),
			{ res12 },
		);

		// Test 13: Negative - Uninspected file edit blocked
		const res13 = guard.checkReadPrecondition(
			secretFile,
			"edit",
			session,
			tmpDir,
			true,
			[{ startLine: 1, endLine: 1 }],
			["SECRET_KEY=123456"],
		);
		assertPass(
			"Uninspected file edit is blocked",
			!res13.allowed && (res13.reason || "").includes("Uninspected File"),
			{ res13 },
		);

		// Test 14: Negative - Stale file drift blocked
		fs.appendFileSync(checksFile, "\n// External git change\n", "utf8");
		const res14 = guard.checkReadPrecondition(
			checksFile,
			"edit",
			session,
			tmpDir,
			true,
			pre10.targetRange ? [pre10.targetRange] : [],
			[zodEdit10],
		);
		assertPass(
			"Stale file drift is caught and blocked",
			!res14.allowed && (res14.reason || "").includes("Stale File Drift"),
			{ res14 },
		);

		// Test 15: Negative - Workspace boundary escape blocked
		const res15 = guard.checkReadPrecondition(
			"/etc/shadow",
			"edit",
			session,
			tmpDir,
			true,
			[{ startLine: 1, endLine: 1 }],
			["root:x:0:0"],
		);
		assertPass(
			"Workspace boundary traversal blocked",
			!res15.allowed && (res15.reason || "").includes("outside the workspace"),
			{ res15 },
		);

		logPass("Complete multi-channel stress matrix verified on production code!");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
