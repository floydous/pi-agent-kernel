// Section 6: Multi-Block Disjoint Patching Suite
// Modular tests for multi-block search/replace, atomic syntax defense, and polyglot coverage.

import { runSection } from "../_setup";
import { testPythonMultiBlock } from "./python_test";
import { testPolyglotMultiBlock } from "./polyglot_test";

export async function runSection06(): Promise<void> {
	await runSection("6. Multi-Block Disjoint Patching Suite", () => {
		testPythonMultiBlock();
		testPolyglotMultiBlock();
	});
}

runSection06().catch((err) => {
	console.error(err);
	process.exit(1);
});
