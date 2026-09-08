// LSP Clean Diagnostics & Reference Filtering Suite

import { runSuite } from "../_setup";
import { testLspCleanDiagnostics } from "./clean_diagnostics_test";
import { testLspReferenceFiltering } from "./reference_filter_test";
import { testLspProvenanceAndDirectoryGuard } from "./provenance_test";
import { testBareSymbolDefinition } from "./bare_symbol_definition_test";

export async function run(): Promise<void> {
	await runSuite("LSP Clean Diagnostics & Reference Filtering Suite", async () => {
		await testLspCleanDiagnostics();
		await testLspReferenceFiltering();
		await testLspProvenanceAndDirectoryGuard();
		await testBareSymbolDefinition();
	});
}

