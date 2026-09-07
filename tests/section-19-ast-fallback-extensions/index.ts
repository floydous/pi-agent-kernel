// Section 19: AST Fallback Extensions Suite
// Modular tests for document symbols, references, and local-scope hover across Python and polyglot.

import { runSection } from "../_setup";
import { testPythonAstExtensions } from "./python_test";
import { testPolyglotAstExtensions } from "./polyglot_test";

export async function runSection19(): Promise<void> {
	await runSection("19. AST Fallback Extensions Suite", async () => {
		testPythonAstExtensions();
		await testPolyglotAstExtensions();
	});
}

runSection19().catch((err) => {
	console.error(err);
	process.exit(1);
});
