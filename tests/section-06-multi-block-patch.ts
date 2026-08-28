// Section 6: Multi-Block Disjoint Patching
// Tests applyMultiBlockPatch with two disjoint edit blocks on the same file.

import { applyMultiBlockPatch } from "../editing/patch";
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
					search: "def process_discount(self, subtotal: float, discount: float) -> float:\n        return subtotal - discount",
					replace: "def process_discount(self, subtotal: float, discount: float) -> float:\n        # Safeguard discount\n        return max(0.0, subtotal - discount)",
				},
			];

			const multiRes = applyMultiBlockPatch("calculator.py", multiBlocks);
			console.log("Multi-block strategy:", multiRes.strategy);
			console.log("Multi-block diff:\n", multiRes.diffOutput);

			assertPass(
				"Multi-block patch applied successfully",
				multiRes.success,
				{ error: multiRes.error }
			);
			logPass("Multi-block patch applied successfully!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
