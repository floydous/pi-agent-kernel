import * as fs from "node:fs";
import * as path from "node:path";
import { applyMultiBlockPatch } from "../../src/editing/patch";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testPythonMultiBlock(): void {
	const ws = createTestWorkspace("multi_py_");
	try {
		process.chdir(ws.tempDir);
		const multiBlocks = [
			{
				search: "self.tax_rate = tax_rate",
				replace: "self.tax_rate = tax_rate\n        self.currency = 'USD'",
			},
			{
				search:
					"def process_discount(self, subtotal: float, discount: float) -> float:\n        \"\"\"Subtract a discount from the subtotal, guarding against negatives.\"\"\"\n        if discount < 0:",
				replace:
					"def process_discount(self, subtotal: float, discount: float) -> float:\n        # Safeguard discount\n        if discount < 0:",
			},
		];

		const multiRes = applyMultiBlockPatch("calculator.py", multiBlocks);
		assertPass("Multi-block patch applied successfully", multiRes.success, { multiRes });
		assertPass(
			"Multi-block target ranges use original-file coordinates",
			multiRes.targetRanges?.length === 2 &&
				multiRes.targetRanges[0].startLine < multiRes.targetRanges[1].startLine,
			{ targetRanges: multiRes.targetRanges },
		);

		// Descending multi-block edits preserve both targets
		const descendingPath = path.join(ws.tempDir, "descending.py");
		fs.writeFileSync(descendingPath, "one\ntwo\nthree\nfour\nfive\n", "utf8");
		const descendingRes = applyMultiBlockPatch(descendingPath, [
			{ search: "four", replace: "FOUR\nFOUR-EXTRA" },
			{ search: "two", replace: "TWO" },
		]);
		assertPass(
			"Descending multi-block edits preserve both targets",
			descendingRes.success &&
				fs.readFileSync(descendingPath, "utf8") === "one\nTWO\nthree\nFOUR\nFOUR-EXTRA\nfive\n" &&
				descendingRes.targetRanges?.[0]?.startLine === 4 &&
				descendingRes.targetRanges?.[1]?.startLine === 2,
			{ descendingRes },
		);

		// Invalid syntax rollback
		const original = fs.readFileSync(ws.calculatorPath, "utf8");
		const invalidMultiRes = applyMultiBlockPatch(ws.calculatorPath, [
			{ search: "self.precision = precision", replace: "self.precision = (precision" },
		]);
		assertPass("Invalid multi-block syntax is rejected", !invalidMultiRes.success, { invalidMultiRes });
		assertPass(
			"File content preserved on syntax failure",
			fs.readFileSync(ws.calculatorPath, "utf8") === original,
			{ invalidMultiRes },
		);

		// Overlap rejection
		const overlapPath = path.join(ws.tempDir, "overlap.txt");
		fs.writeFileSync(overlapPath, "line1\nline2\nline3\nline4\n", "utf8");
		const overlapRes = applyMultiBlockPatch(overlapPath, [
			{ search: "line2\nline3", replace: "L23" },
			{ search: "line3\nline4", replace: "L34" },
		]);
		assertPass("Overlapping target ranges are rejected fail-closed", !overlapRes.success, { overlapRes });
		assertPass(
			"Overlap rejection preserves content",
			fs.readFileSync(overlapPath, "utf8") === "line1\nline2\nline3\nline4\n",
			{ overlapRes },
		);

		logPass("Python multi-block patching passed!");
	} finally {
		ws.cleanup();
	}
}
