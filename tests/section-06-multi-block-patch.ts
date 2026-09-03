// Section 6: Multi-Block Disjoint Patching
// Tests applyMultiBlockPatch with two disjoint edit blocks on the same file.

import * as fs from "node:fs";
import * as path from "node:path";
import { applyMultiBlockPatch } from "../src/editing/patch";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("6. Multi-Block Disjoint Patching", () => {
		const ws = createTestWorkspace();
		try {
			process.chdir(ws.tempDir);
			const multiBlocks = [
				{
					search: "self.precision = precision",
					replace: "self.precision = precision\n        self.currency = 'USD'",
				},
				{
					search:
						"def process_discount(self, subtotal: float, discount: float) -> float:\n        return subtotal - discount",
					replace:
						"def process_discount(self, subtotal: float, discount: float) -> float:\n        # Safeguard discount\n        return max(0.0, subtotal - discount)",
				},
			];

			const multiRes = applyMultiBlockPatch("calculator.py", multiBlocks);
			console.log("Multi-block strategy:", multiRes.strategy);
			console.log("Multi-block diff:\n", multiRes.diffOutput);

			assertPass("Multi-block patch applied successfully", multiRes.success, {
				error: multiRes.error,
			});
			assertPass(
				"Multi-block target ranges use original-file coordinates",
				multiRes.targetRanges?.length === 2 &&
					multiRes.targetRanges[0].startLine < multiRes.targetRanges[1].startLine,
				{ targetRanges: multiRes.targetRanges },
			);

			const original = fs.readFileSync(ws.calculatorPath, "utf8");
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

			const invalidMultiRes = applyMultiBlockPatch(ws.calculatorPath, [
				{ search: "self.precision = precision", replace: "self.precision = (precision" },
				{ search: "return subtotal - discount", replace: "return subtotal - discount" },
			]);
			assertPass(
				"Invalid multi-block candidate is rejected before writing",
				!invalidMultiRes.success,
				{ invalidMultiRes },
			);
			assertPass(
				"Failed multi-block validation preserves all prior content",
				fs.readFileSync(ws.calculatorPath, "utf8") === original,
				{ invalidMultiRes },
			);
			logPass("Multi-block patch and atomic syntax gate verified!");

			// Overlapping / ambiguous search targets are rejected fail-closed
			const overlapPath = path.join(ws.tempDir, "overlap.txt");
			fs.writeFileSync(overlapPath, "line1\nline2\nline3\nline4\n", "utf8");
			const overlapRes = applyMultiBlockPatch(overlapPath, [
				{ search: "line2\nline3", replace: "L23" },
				{ search: "line3\nline4", replace: "L34" },
			]);
			assertPass("Overlapping target ranges are rejected fail-closed", !overlapRes.success, {
				overlapRes,
			});
			assertPass("Rejected overlap preserves file content", fs.readFileSync(overlapPath, "utf8") === "line1\nline2\nline3\nline4\n", {
				overlapRes,
			});

			// Multiline block with trailing newline variations matches cleanly
			const multilinePath = path.join(ws.tempDir, "multiline.txt");
			fs.writeFileSync(multilinePath, "header\nalpha\nbeta\ngamma\nfooter\n", "utf8");
			const multilineRes = applyMultiBlockPatch(multilinePath, [
				{ search: "alpha\nbeta\n", replace: "ALPHA\nBETA\n" },
				{ search: "gamma\n", replace: "GAMMA\n" },
			]);
			assertPass("Multiline search/replace blocks with trailing newlines apply cleanly", multilineRes.success, {
				multilineRes,
			});
			assertPass("Multiline file content reflects both blocks", fs.readFileSync(multilinePath, "utf8") === "header\nALPHA\nBETA\nGAMMA\nfooter\n", {
				multilineRes,
			});
			logPass("Multi-block edge cases (overlap rejection and multiline newline fidelity) verified!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
