// LSP Formatters Suite

import { runSuite } from "../_setup";
import { testLspFormatterDiagnostics } from "./diagnostics_test";
import { testLspFormatterSymbols } from "./symbols_test";

export async function run(): Promise<void> {
	await runSuite("LSP Formatters Suite", () => {
		testLspFormatterDiagnostics();
		testLspFormatterSymbols();
	});
}

