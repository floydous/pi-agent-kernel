// Section 7: Syntax Verification Suite
// Modular tests for syntax verification across Python and TypeScript.

import { runSection } from "../_setup";
import { testPythonSyntax } from "./python_syntax_test";
import { testTypescriptSyntax } from "./typescript_syntax_test";

export async function runSection07(): Promise<void> {
	await runSection("7. Syntax Verification Suite", () => {
		testPythonSyntax();
		testTypescriptSyntax();
	});
}

runSection07().catch((err) => {
	console.error(err);
	process.exit(1);
});
