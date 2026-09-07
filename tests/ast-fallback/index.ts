// AST Fallback Extensions Suite
// Modular tests for document symbols, references, and local-scope hover across Python and polyglot.

import { runSuite } from "../_setup";
import { testPythonAstExtensions } from "./python_test";
import { testPolyglotAstExtensions } from "./polyglot_test";

export async function run(): Promise<void> {
	await runSuite("AST Fallback Extensions Suite", async () => {
		testPythonAstExtensions();
		await testPolyglotAstExtensions();
	});
}

