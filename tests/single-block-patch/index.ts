// Single-Block Surgical Patching Suite
// Modular tests for single-block search/replace and atomic syntax defense across languages.

import { runSuite } from "../_setup";
import { testPythonSingleBlock } from "./python_patch_test";
import { testPolyglotSingleBlock } from "./polyglot_patch_test";

export async function run(): Promise<void> {
	await runSuite("Single-Block Surgical Patching Suite", () => {
		testPythonSingleBlock();
		testPolyglotSingleBlock();
	});
}

