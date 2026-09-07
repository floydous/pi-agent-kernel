// Targeted Symbol Reader Suite
// Modular tests for polyglot surgical symbol extraction and monolithic file readers.

import { runSuite } from "../_setup";
import { testPolyglotSymbolReader } from "./polyglot_symbols_test";
import { testMonolithicPythonFile } from "./monolithic_test";

export async function run(): Promise<void> {
	await runSuite("Targeted Symbol Reader Suite", async () => {
		await testPolyglotSymbolReader();
		testMonolithicPythonFile();
	});
}

