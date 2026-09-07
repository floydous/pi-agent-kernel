// Read-Before-Write Epistemic Guard Suite
// Modular tests for basic guard, bash extraction, and case-sensitivity.

import { runSuite } from "../_setup";
import { testGuardBasic } from "./basic_test";
import { testBashInspectionExtraction } from "./bash_extraction_test";
import { testCaseSensitivity } from "./case_sensitivity_test";
import { testSessionIsolation } from "./session_isolation_test";

export async function run(): Promise<void> {
	await runSuite("Read-Before-Write Epistemic Guard Suite", () => {
		testGuardBasic();
		testBashInspectionExtraction();
		testCaseSensitivity();
		testSessionIsolation();
	});
}

