// Multi-Block Disjoint Patching Suite
// Modular tests for multi-block search/replace, atomic syntax defense, and polyglot coverage.

import { runSuite } from "../_setup";
import { testPythonMultiBlock } from "./python_test";
import { testPolyglotMultiBlock } from "./polyglot_test";

export async function run(): Promise<void> {
	await runSuite("Multi-Block Disjoint Patching Suite", () => {
		testPythonMultiBlock();
		testPolyglotMultiBlock();
	});
}

