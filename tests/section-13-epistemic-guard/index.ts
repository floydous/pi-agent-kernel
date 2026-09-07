// Section 13: Read-Before-Write Epistemic Guard Suite
// Modular tests for basic guard, bash extraction, and case-sensitivity.

import { runSection } from "../_setup";
import { testGuardBasic } from "./basic_test";
import { testBashInspectionExtraction } from "./bash_extraction_test";
import { testCaseSensitivity } from "./case_sensitivity_test";

export async function runSection13(): Promise<void> {
	await runSection("13. Read-Before-Write Epistemic Guard Suite", () => {
		testGuardBasic();
		testBashInspectionExtraction();
		testCaseSensitivity();
	});
}

runSection13().catch((err) => {
	console.error(err);
	process.exit(1);
});
