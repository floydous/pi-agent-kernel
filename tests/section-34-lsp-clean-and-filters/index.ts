// Section 34: LSP Clean Diagnostics & Reference Filtering Suite

import { runSection } from "../_setup";
import { testLspCleanDiagnostics } from "./clean_diagnostics_test";
import { testLspReferenceFiltering } from "./reference_filter_test";

export async function runSection34(): Promise<void> {
	await runSection("34. LSP Clean Diagnostics & Reference Filtering Suite", async () => {
		await testLspCleanDiagnostics();
		await testLspReferenceFiltering();
	});
}

runSection34().catch((err) => {
	console.error(err);
	process.exit(1);
});
