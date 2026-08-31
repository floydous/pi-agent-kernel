// Section 7: Syntax Verification
// Tests checkSyntax detects valid and broken Python.

import * as fs from "node:fs";
import { checkSyntax } from "../src/editing/syntax-verify";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("7. Syntax Verification", () => {
		const ws = createTestWorkspace();
		try {
			const validSyntax = checkSyntax(ws.calculatorPath);
			console.log("Valid syntax check:", validSyntax.valid);

			// Inject broken python syntax to test error catcher
			fs.writeFileSync(ws.calculatorPath, "def broken_func(:", "utf8");
			const brokenSyntax = checkSyntax(ws.calculatorPath);
			console.log("Broken syntax caught:", !brokenSyntax.valid);

			assertPass(
				"Syntax verification test passed",
				validSyntax.valid && !brokenSyntax.valid,
				{ validSyntax, brokenSyntax }
			);
			logPass("Syntax verification test passed!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
