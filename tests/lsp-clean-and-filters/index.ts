// LSP Clean Diagnostics & Reference Filtering Suite

import { runSuite } from "../_setup";
import { testLspCleanDiagnostics } from "./clean_diagnostics_test";
import { testLspReferenceFiltering } from "./reference_filter_test";

export async function run(): Promise<void> {
	await runSuite("LSP Clean Diagnostics & Reference Filtering Suite", async () => {
		await testLspCleanDiagnostics();
		await testLspReferenceFiltering();
	});
}

