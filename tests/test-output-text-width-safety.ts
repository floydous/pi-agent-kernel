/**
 * Regression test for the TUI width-overflow crash.
 *
 * The crash: pi's TUI hard-asserts that every rendered line fits within
 * `terminal.columns`. The agent-kernel's tool renderers used to call
 * `text.setText(...)` on `context.lastComponent ?? new Text("", 0, 0)` and
 * return the result. When `lastComponent` was pi's `contentText`
 * (`new Text("", 1, 1, ...)`), the returned Text had `paddingX=1`. Pi's
 * parent `contentBox` (also `paddingX=1`) called `text.render(width-2)`,
 * and the Text further reserved `paddingX*2 = 2` cells inside that,
 * double-counting the padding and producing a rendered line a few cells
 * wider than the terminal could hold.
 *
 * The fix: a new helper `makeOutputText` in `ui/tui_utils.ts` that always
 * creates a fresh `Text` with `paddingX=0` and truncates each input line
 * to a safe width derived from `process.stdout.columns`. All 12 tool
 * renderers now go through this helper.
 *
 * This test verifies:
 *   1. The helper truncates lines longer than the safe width.
 *   2. The helper does not widen short lines.
 *   3. The helper returns a `Text` whose `render(width)` produces lines
 *      that fit within `width` (no double-padding accumulation).
 *   4. A reproduction of the original crash input (a 224-char source line)
 *      produces a Text that, when rendered at the offending 207 width,
 *      still fits.
 */
import { Text, makeOutputText, getSafeLineWidth, visibleWidth } from "../ui/tui_utils";

let passed = 0;
let failed = 0;

function expect(label: string, cond: boolean): void {
	if (cond) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}`);
		failed++;
	}
}

function main(): void {
	console.log("\n[output-text width-safety verification]\n");

	// --- Test 1: helper truncates long lines ---
	{
		const longLine = "x".repeat(500);
		const t = makeOutputText(longLine);
		const lines = t.render(204);
		const maxW = Math.max(...lines.map(visibleWidth));
		expect(`500-char input is truncated: max rendered line width (${maxW}) <= safe width`, maxW <= getSafeLineWidth());
	}

	// --- Test 2: helper does not widen short lines ---
	{
		const shortLine = "hello world";
		const t = makeOutputText(shortLine);
		const lines = t.render(204);
		const totalTextWidth = lines.map(visibleWidth).reduce((a, b) => a + b, 0);
		// The short text should still appear in the output (only one non-empty line expected).
		expect(`short input is preserved: rendered output contains "hello world"`,
			lines.some((l) => l.includes("hello world")));
		expect(`short input produces a single non-empty line: total width ${totalTextWidth} <= 20`, totalTextWidth <= 20);
	}

	// --- Test 3: helper returns a fresh Text (not from lastComponent) ---
	{
		const t1 = makeOutputText("foo");
		const t2 = makeOutputText("foo");
		expect(`makeOutputText returns a fresh Text instance (not reused)`, t1 !== t2);
		expect(`returned Text has paddingX=0`, t1.paddingX === 0);
	}

	// --- Test 4: the original crash reproduction ---
	// The actual line that crashed the TUI at 204-wide.
	{
		const sourceLine = `      "You are a context summarization assistant. Produce the structured summary following the exact format specified. Reconcile all tasks against git ground truth and recent tool outputs. Do NOT continue the conversation.\n\n`;
		const themedOutput = `\n${sourceLine}`;
		const t = makeOutputText(themedOutput);
		// Render at the original 204 width AND at the wider 207 width that the
		// crash log showed.
		for (const w of [200, 202, 204, 206, 207, 208, 250, 500]) {
			const lines = t.render(w);
			const maxW = Math.max(...lines.map(visibleWidth));
			expect(`224-char source line, render(${w}): max w=${maxW} <= ${w}`, maxW <= w);
		}
	}

	// --- Test 5: multi-line input ---
	{
		const multiLine = "short line 1\nshort line 2\n" + "x".repeat(500) + "\nshort line 4";
		const t = makeOutputText(multiLine);
		const lines = t.render(204);
		const maxW = Math.max(...lines.map(visibleWidth));
		expect(`multi-line input: each line truncated, max w=${maxW} <= ${getSafeLineWidth()}`, maxW <= getSafeLineWidth());
		expect(`multi-line input: line count preserved (4 input lines + 1 truncated = 4 rendered)`,
			lines.filter((l) => l.length > 0).length >= 4);
	}

	// --- Test 6: when the safe width is wider than the input, no truncation marker ---
	{
		const t = makeOutputText("short");
		const text = t.render(204)[0];
		expect(`short input has no ellipsis`, !text.includes("…"));
	}

	// --- Test 7: empty input ---
	{
		const t = makeOutputText("");
		const lines = t.render(204);
		expect(`empty input produces no visible lines`, lines.length === 0 || lines.every((l) => l.length === 0));
	}

	// --- Test 8: getSafeLineWidth is bounded ---
	{
		const w = getSafeLineWidth();
		expect(`getSafeLineWidth is at least 40: ${w} >= 40`, w >= 40);
		expect(`getSafeLineWidth is finite and positive: ${w} > 0`, w > 0);
	}

	console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
	process.exit(failed > 0 ? 1 : 0);
}

main();
