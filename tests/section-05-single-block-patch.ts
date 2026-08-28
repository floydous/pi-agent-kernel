// Section 5: Single-Block Surgical Patching
// Tests applySurgicalPatch with a relative path on a file in the workspace.

import * as fs from "node:fs";
import { applySurgicalPatch } from "../src/editing/patch";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("5. Single-Block Surgical Patching", () => {
		const ws = createTestWorkspace();
		try {
			process.chdir(ws.tempDir);
			const searchBlock = `
  def calculate_tax(self, subtotal: float) -> float:
      """Calculate tax based on subtotal."""
      return subtotal * 0.08
`;
			const replaceBlock = `    def calculate_tax(self, subtotal: float) -> float:
        """Calculate tax based on subtotal."""
        # Updated to 10% tax rate
        return subtotal * 0.10`;

			const patchResult = applySurgicalPatch(
				"calculator.py",
				searchBlock,
				replaceBlock,
			);
			console.log("Strategy used:", patchResult.strategy);
			console.log("Diff:\n", patchResult.diffOutput);

			assertPass(
				"Single block surgical patch applied successfully",
				patchResult.success,
				{ error: patchResult.error },
			);

			const original = fs.readFileSync(ws.calculatorPath, "utf8");
			const invalid = applySurgicalPatch(
				ws.calculatorPath,
				"return subtotal * 0.10",
				"return subtotal * (0.10",
			);
			assertPass(
				"Invalid candidate is rejected before writing",
				!invalid.success,
				{ invalid },
			);
			assertPass(
				"Failed syntax validation preserves the original file",
				fs.readFileSync(ws.calculatorPath, "utf8") === original,
				{ invalid },
			);
			logPass("Single block surgical patch and atomic syntax gate verified!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
