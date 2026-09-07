// Section 5: Single-Block Surgical Patching Suite
// Modular tests for single-block search/replace and atomic syntax defense across languages.

import { runSection } from "../_setup";
import { testPythonSingleBlock } from "./python_patch_test";
import { testPolyglotSingleBlock } from "./polyglot_patch_test";

export async function runSection05(): Promise<void> {
	await runSection("5. Single-Block Surgical Patching Suite", () => {
		testPythonSingleBlock();
		testPolyglotSingleBlock();
	});
}

runSection05().catch((err) => {
	console.error(err);
	process.exit(1);
});
