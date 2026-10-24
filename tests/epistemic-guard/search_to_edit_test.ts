import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EpistemicGuard,
	parseGrepOutput,
} from "../../src/safety/epistemic_guard";
import { assertPass, logPass } from "../_setup";

export function testSearchToEdit(): void {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-to-edit-test-"));
	const testFile = path.join(tempDir, "service.ts");
	const sessionId = "test-search-session";

	const fileContent = [
		"import { Router } from 'express';",
		"export const router = Router();",
		"",
		"// Route handler",
		"router.get('/health', (req, res) => {",
		"  res.json({ status: 'ok' });",
		"});",
		"",
		"export const PORT = 3000;",
		"export const TIMEOUT = 5000;",
		"",
		"export function startServer() {",
		"  console.log('Starting server on port', PORT);",
		"}",
	].join("\n");

	fs.writeFileSync(testFile, fileContent, "utf8");

	try {
		// Test 1: parseGrepOutput parses context lines and hit lines
		const rawRgOutput = [
			`${testFile}-7-});`,
			`${testFile}-8-`,
			`${testFile}:9:export const PORT = 3000;`,
			`${testFile}:10:export const TIMEOUT = 5000;`,
			`${testFile}-11-`,
			`${testFile}-12-export function startServer() {`,
		].join("\n");

		const parsed = parseGrepOutput(rawRgOutput, [testFile], tempDir);
		const lines = parsed.get(path.normalize(testFile)) || [];
		assert.deepStrictEqual(lines, [7, 8, 9, 10, 11, 12]);
		assertPass("parseGrepOutput captures all emitted match and context lines", lines.length === 6);

		const hits = parsed.searchHits?.get(path.normalize(testFile)) || [];
		assert.deepStrictEqual(hits.map((h) => h.line), [9, 10]);
		assertPass("parseGrepOutput records exact hit lines", hits.length === 2);
		logPass("parseGrepOutput context and match line extraction");

		// Test 2: Windows drive letter path parsing (on Windows)
		if (process.platform === "win32") {
			const explicitWinPath = "C:\\project-hyphen\\src\\app.ts";
			const winRgOutput = `${explicitWinPath}:9:export const PORT = 3000;\n${explicitWinPath}-10-export const TIMEOUT = 5000;\n`;
			const winParsed = parseGrepOutput(winRgOutput, [explicitWinPath], "C:\\project-hyphen");
			const winLines = winParsed.get(path.normalize(explicitWinPath)) || [];
			assert.deepStrictEqual(winLines, [9, 10]);
			assertPass("parseGrepOutput supports Windows drive letter paths", winLines.length === 2);
			logPass("parseGrepOutput Windows drive letter path support");
		}

		// Test 2b: POSIX path with hyphens
		const posixPath = `${tempDir}/hyphen-dir/service-worker.ts`;
		const posixRgOutput = `${posixPath}:9:export const PORT = 3000;\n${posixPath}-10-export const TIMEOUT = 5000;\n`;
		const posixParsed = parseGrepOutput(posixRgOutput, [posixPath], tempDir);
		const posixLines = posixParsed.get(path.normalize(posixPath)) || [];
		assert.deepStrictEqual(posixLines, [9, 10]);
		assertPass("parseGrepOutput supports POSIX paths with hyphens", posixLines.length === 2);
		logPass("parseGrepOutput POSIX hyphenated path support");

		// Test 2c: Filename and directory with -<digits>- pattern (avoids context delimiter confusion)
		const digitsPath = `${tempDir}/project-2024-dir/foo-2024-bar.ts`;
		const digitsRgOutput = `${digitsPath}:9:export const PORT = 3000;\n${digitsPath}-10-export const TIMEOUT = 5000;\n`;
		const digitsParsed = parseGrepOutput(digitsRgOutput, [digitsPath], tempDir);
		const digitsLines = digitsParsed.get(path.normalize(digitsPath)) || [];
		assert.deepStrictEqual(digitsLines, [9, 10]);
		const digitsHits = digitsParsed.searchHits?.get(path.normalize(digitsPath)) || [];
		assert.deepStrictEqual(digitsHits.map((h) => h.line), [9]);
		assertPass("parseGrepOutput correctly distinguishes -<digits>- in path from context line delimiter", digitsLines.length === 2 && digitsHits.length === 1);
		logPass("parseGrepOutput disambiguation for -<digits>- in path names");

		// Test 2d: Column number format (--column with :line:col:)
		const colPath = `${tempDir}/src/app.ts`;
		const colRgOutput = `${colPath}:45:12:const port = 3000;\n`;
		const colParsed = parseGrepOutput(colRgOutput, [colPath], tempDir);
		const colLines = colParsed.get(path.normalize(colPath)) || [];
		assert.deepStrictEqual(colLines, [45]);
		const colHits = colParsed.searchHits?.get(path.normalize(colPath)) || [];
		assert.deepStrictEqual(colHits.map((h) => h.line), [45]);
		assertPass("parseGrepOutput supports rg --column format", colLines.length === 1 && colHits.length === 1);
		logPass("parseGrepOutput column number format support");

		// Test 3: ANSI escape codes and '--' group separators
		const ansiRgOutput = [
			`\u001b[32m${testFile}\u001b[0m\u001b[36m:9:\u001b[0mexport const PORT = 3000;`,
			"--",
			`\u001b[32m${testFile}\u001b[0m\u001b[36m:10:\u001b[0mexport const TIMEOUT = 5000;`,
		].join("\n");
		const ansiParsed = parseGrepOutput(ansiRgOutput, [testFile], tempDir);
		const ansiLines = ansiParsed.get(path.normalize(testFile)) || [];
		assert.deepStrictEqual(ansiLines, [9, 10]);
		assertPass("parseGrepOutput strips ANSI codes and skips '--' separators", ansiLines.length === 2);
		logPass("parseGrepOutput ANSI stripping and separator skipping");

		// Test 4: Guard authorizes edit overlapping search hit with surrounding context (Tier 1.5)
		const guard = new EpistemicGuard();
		guard.recordCommandExecution(`rg -n "PORT" ${testFile}`, tempDir, sessionId, true, `${testFile}:9:export const PORT = 3000;\n`);

		// Edit targeting lines 8-10 (anchored around hit line 9, within 1 line before/after)
		const overlapCheck = guard.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 8, endLine: 10 }],
			["\nexport const PORT = 3000;\nexport const TIMEOUT = 5000;"],
		);
		assertPass("Verified search overlap (Tier 1.5) authorizes anchored search block", overlapCheck.allowed === true);
		logPass("Tier 1.5 Verified Search Overlap authorization");

		// Test 5: Bounded micro-hydration for adjacent edit
		// Hit was at line 9. Edit targets line 10 alone with a short 1-line block (<35 chars, non-substantive)
		const adjacentCheck = guard.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 10, endLine: 10 }],
			["export const TIMEOUT = 5000;"],
		);
		assertPass("Bounded micro-hydration authorizes adjacent line edit", adjacentCheck.allowed === true);
		logPass("Bounded micro-hydration for adjacent line edit");

		// Test 6: Distant uninspected line remains blocked
		// Edit targets line 2 (import/router, distant from line 9 hit) with a short 1-line block (<35 chars)
		const distantCheck = guard.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 2, endLine: 2 }],
			["export const router = Router();"],
		);
		assertPass("Distant unobserved line remains blocked", distantCheck.allowed === false);
		assertPass("Reason guides to read", Boolean(distantCheck.reason?.includes("BLOCKED: Target lines not covered by visible read")));
		logPass("Distant unobserved line fails closed");

		// Test 7: Post-search external file modification fails closed (TOCTOU stale file drift)
		fs.writeFileSync(testFile, fileContent + "\n// modified externally", "utf8");
		const staleCheck = guard.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 9, endLine: 9 }],
			["export const PORT = 3000;"],
		);
		assertPass("Post-search external modification triggers Stale File Drift", staleCheck.allowed === false);
		assertPass("Reason reports Stale File Drift", Boolean(staleCheck.reason?.includes("BLOCKED: Stale File Drift")));
		assertPass("Stale drift includes pinpoint read remedy with offset and limit", Boolean(staleCheck.reason?.includes("offset: 7, limit: 15")), { reason: staleCheck.reason });
		logPass("Post-search external modification fails closed");

		// Restore original content
		fs.writeFileSync(testFile, fileContent, "utf8");

		// Test 8: Overlap context boundary (> 3 lines before/after hit fails Tier 1.5)
		// Range 5-11 has 4 lines before hit line 9 (>3 lines before) and non-substantive replacement
		const overExpandedCheck = guard.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 5, endLine: 11 }],
			["// short"],
		);
		assertPass("Over-expanded search block (>3 context lines) fails Tier 1.5", overExpandedCheck.allowed === false);
		logPass("Search overlap context boundary check");

		// Test 9: Micro-hydration distance boundary (> 2 lines away fails hydration)
		// Hit at line 9. Target at line 13 is 4 lines away (>2 lines) and non-substantive (<35 chars)
		const tooFarAdjacentCheck = guard.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 13, endLine: 13 }],
			["  console.log('hi');"],
		);
		assertPass("Target >2 lines away from hit fails micro-hydration", tooFarAdjacentCheck.allowed === false);
		logPass("Micro-hydration distance boundary check");

		console.log("✓ All Search-to-Edit tests passed successfully!\n");
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}
}

if (process.argv[1]?.endsWith("search_to_edit_test.ts")) {
	testSearchToEdit();
}
