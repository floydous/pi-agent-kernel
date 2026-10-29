// Syntax Verification Suite
// Modular tests for syntax verification across Python and TypeScript.

import { runSuite } from "../_setup";
import { testPythonSyntax } from "./python_syntax_test";
import { testTypescriptSyntax } from "./typescript_syntax_test";
import { testExecutableResolution } from "./executable_resolution_test";
import { testTreeSitterGate } from "./tree_sitter_gate_test";

export async function run(): Promise<void> {
	await runSuite("Syntax Verification Suite", async () => {
		testPythonSyntax();
		testTypescriptSyntax();
		testExecutableResolution();
		await testTreeSitterGate();
	});
}

