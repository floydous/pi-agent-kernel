// Section 4: Targeted Symbol Reader Suite
// Modular tests for polyglot surgical symbol extraction and monolithic file readers.

import { runSection } from "../_setup";
import { testPolyglotSymbolReader } from "./polyglot_symbols_test";
import { testMonolithicPythonFile } from "./monolithic_test";

export async function runSection04(): Promise<void> {
	await runSection("4. Targeted Symbol Reader Suite", async () => {
		await testPolyglotSymbolReader();
		testMonolithicPythonFile();
	});
}

runSection04().catch((err) => {
	console.error(err);
	process.exit(1);
});
