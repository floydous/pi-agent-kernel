// Section 5: Single-Block Surgical Patching
// Tests applySurgicalPatch with a relative path on a file in the workspace.

import { applySurgicalPatch } from "../editing/patch";
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

			const patchResult = applySurgicalPatch("calculator.py", searchBlock, replaceBlock);
			console.log("Strategy used:", patchResult.strategy);
			console.log("Diff:\n", patchResult.diffOutput);

			assertPass(
				"Single block surgical patch applied successfully",
				patchResult.success,
				{ error: patchResult.error }
			);
			logPass("Single block surgical patch applied successfully!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
