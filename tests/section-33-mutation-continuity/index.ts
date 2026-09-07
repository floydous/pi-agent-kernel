// Section 33: Epistemic Guard Mutation Continuity & Interference Defense Suite

import { runSection } from "../_setup";
import { testSequentialEdits } from "./sequential_test";
import { testExternalMutationDefense } from "./external_drift_test";

export async function runSection33(): Promise<void> {
	await runSection("33. Epistemic Guard Mutation Continuity & Interference Defense Suite", () => {
		testSequentialEdits();
		testExternalMutationDefense();
	});
}

runSection33().catch((err) => {
	console.error(err);
	process.exit(1);
});
