import { clampCommandOutput } from "../../src/safety/output_clamper";
import { assertPass, logPass } from "../_setup";

export function testDiagnosticWindowRetention(): void {
	// 1. A test run with an AssertionError in the middle must retain the assertion within budget
	const lines = ["RUN vitest v1.0.0", ""];
	for (let i = 1; i <= 40; i++) {
		lines.push(`  ✓ test/suite_${i}.test.ts passed (${i}ms)`);
	}
	lines.push("  FAIL  test/route.test.ts");
	lines.push("  AssertionError: expected '/docs/' to be '/docs/index'");
	lines.push("    - Expected: '/docs/index'");
	lines.push("    + Received: '/docs/'");
	for (let i = 1; i <= 25; i++) {
		lines.push(`  info: coverage module_${i}.ts 95%`);
	}
	lines.push("Test Files: 1 failed | 40 passed (41)");
	lines.push("Duration: 2.1s");

	const raw = lines.join("\n");
	const clamped = clampCommandOutput(raw, "npm test", { maxLines: 40, isError: true });

	assertPass(
		"Diagnostic window retains AssertionError in failure output within 40 lines budget",
		clamped.text.includes("AssertionError:") &&
		clamped.text.includes("expected '/docs/' to be '/docs/index'") &&
		clamped.text.includes("Test Files: 1 failed") &&
		clamped.shownLines <= 40,
		{ clampedText: clamped.text, shownLines: clamped.shownLines }
	);

	// 2. Discovery command (rg) containing AssertionError match in the middle must NOT trigger diagnostic window
	const discoveryLines = [];
	for (let i = 1; i <= 100; i++) {
		if (i === 50) {
			discoveryLines.push(`src/file_${i}.ts:${i}: AssertionError: expected something`);
		} else {
			discoveryLines.push(`src/file_${i}.ts:${i}: export const item_${i} = ${i};`);
		}
	}
	const clampedDiscovery = clampCommandOutput(discoveryLines.join("\n"), "rg 'export const'", { maxLines: 40 });
	assertPass(
		"Discovery command stays bounded to maxLines and ignores diagnostic patterns in grep matches",
		clampedDiscovery.shownLines <= 40 &&
		!clampedDiscovery.text.includes("file_50.ts") && // Middle match at line 50 was omitted by standard symmetric 20/20 split
		clampedDiscovery.text.includes("file_1.ts") &&
		clampedDiscovery.text.includes("file_100.ts"),
		{ shownLines: clampedDiscovery.shownLines, textSnippet: clampedDiscovery.text.slice(0, 200) }
	);

	// 3. Successful command output containing "Error:" in normal text without failure status retains standard symmetric split
	const docLines = [];
	for (let i = 1; i <= 100; i++) {
		if (i === 50) {
			docLines.push(`Line ${i}: The Error: class represents standard error handling in documentation.`);
		} else {
			docLines.push(`Line ${i}: Documentation paragraph content.`);
		}
	}
	const clampedDoc = clampCommandOutput(docLines.join("\n"), "cat docs.md", { maxLines: 40, isError: false });
	assertPass(
		"Successful command output with 'Error:' retains standard symmetric clamping",
		clampedDoc.shownLines <= 40 &&
		!clampedDoc.text.includes("Line 50:") && // Middle line 50 omitted by symmetric 20/20 split
		clampedDoc.text.includes("Line 1:") &&
		clampedDoc.text.includes("Line 100:"),
		{ shownLines: clampedDoc.shownLines }
	);

	// 4. Benign command output containing FAIL heading or rust trace when isError is false retains symmetric split
	const benignFailLines = [];
	for (let i = 1; i <= 100; i++) {
		if (i === 50) {
			benignFailLines.push("FAIL test fixture demonstration example");
		} else if (i === 51) {
			benignFailLines.push("--> src/file.ts:1:1");
		} else {
			benignFailLines.push(`Line ${i}: Documentation or fixture text.`);
		}
	}
	const clampedBenign = clampCommandOutput(benignFailLines.join("\n"), "cat test_fixture.md", { maxLines: 40, isError: false });
	assertPass(
		"Benign successful command with 'FAIL' in content retains standard symmetric clamping",
		clampedBenign.shownLines <= 40 &&
		!clampedBenign.text.includes("FAIL test fixture") && // Middle line omitted
		clampedBenign.text.includes("Line 1:") &&
		clampedBenign.text.includes("Line 100:"),
		{ shownLines: clampedBenign.shownLines }
	);

	// 5. Test command without explicit isError flag (options.isError undefined) with structured FAIL header centers around failure
	const unflaggedTestLines = [];
	for (let i = 1; i <= 100; i++) {
		if (i === 50) {
			unflaggedTestLines.push("FAIL test/unit/service.test.ts");
		} else if (i === 51) {
			unflaggedTestLines.push("AssertionError: expected true to be false");
		} else {
			unflaggedTestLines.push(`Line ${i}: suite passing log`);
		}
	}
	const clampedUnflagged = clampCommandOutput(unflaggedTestLines.join("\n"), "npx vitest run", { maxLines: 40 });
	assertPass(
		"Test runner command without explicit isError flag detects structured FAIL header and retains failure window",
		clampedUnflagged.shownLines <= 40 &&
		clampedUnflagged.text.includes("FAIL test/unit/service.test.ts") &&
		clampedUnflagged.text.includes("AssertionError: expected true to be false"),
		{ shownLines: clampedUnflagged.shownLines }
	);

	// 6. Successful test command (isError: false) containing "FAIL fixture example" must retain standard symmetric clamping
	const testFixturePassLines = [];
	for (let i = 1; i <= 100; i++) {
		if (i === 50) {
			testFixturePassLines.push("  ✓ test/fixture.test.ts > handles FAIL fixture example gracefully");
		} else {
			testFixturePassLines.push(`Line ${i}: test suite passing log`);
		}
	}
	const clampedTestSuccess = clampCommandOutput(testFixturePassLines.join("\n"), "npx vitest run", { maxLines: 40, isError: false });
	assertPass(
		"Explicit successful test run (isError: false) retains symmetric clamping even with 'FAIL' in test title",
		clampedTestSuccess.shownLines <= 40 &&
		!clampedTestSuccess.text.includes("handles FAIL fixture example") && // Middle line omitted
		clampedTestSuccess.text.includes("Line 1:") &&
		clampedTestSuccess.text.includes("Line 100:"),
		{ shownLines: clampedTestSuccess.shownLines }
	);

	logPass("Diagnostic window retention verified!");
}
