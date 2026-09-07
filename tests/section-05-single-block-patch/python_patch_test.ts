import * as fs from "node:fs";
import * as path from "node:path";
import { applySurgicalPatch } from "../../src/editing/patch";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testPythonSingleBlock(): void {
	const ws = createTestWorkspace("patch_py_");
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

		const patchResult = applySurgicalPatch("calculator.py", searchBlock, replaceBlock);
		assertPass("Single block surgical patch applied successfully", patchResult.success, {
			error: patchResult.error,
		});

		const original = fs.readFileSync(ws.calculatorPath, "utf8");
		const invalid = applySurgicalPatch(
			ws.calculatorPath,
			"return subtotal * 0.10",
			"return subtotal * (0.10",
		);
		assertPass("Invalid Python syntax rejected before writing", !invalid.success, { invalid });
		assertPass(
			"Failed syntax validation preserves the original file",
			fs.readFileSync(ws.calculatorPath, "utf8") === original,
			{ invalid },
		);

		logPass("Python single-block patch & atomic rollback verified!");
	} finally {
		ws.cleanup();
	}
}
