// Syntax Verification Suite
// Modular tests for syntax verification across Python and TypeScript.

import { runSuite } from "../_setup";
import { testPythonSyntax } from "./python_syntax_test";
import { testTypescriptSyntax } from "./typescript_syntax_test";

export async function run(): Promise<void> {
	await runSuite("Syntax Verification Suite", () => {
		testPythonSyntax();
		testTypescriptSyntax();
	});
}

