// Section 17: LSP Formatters Suite

import { runSection } from "../_setup";
import { testLspFormatterDiagnostics } from "./diagnostics_test";
import { testLspFormatterSymbols } from "./symbols_test";

export async function runSection17(): Promise<void> {
	await runSection("17. LSP Formatters Suite", () => {
		testLspFormatterDiagnostics();
		testLspFormatterSymbols();
	});
}

runSection17().catch((err) => {
	console.error(err);
	process.exit(1);
});
