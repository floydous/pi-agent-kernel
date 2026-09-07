// Epistemic Guard Mutation Continuity & Interference Defense Suite

import { runSuite } from "../_setup";
import { testSequentialEdits } from "./sequential_test";
import { testExternalMutationDefense } from "./external_drift_test";

export async function run(): Promise<void> {
	await runSuite("Epistemic Guard Mutation Continuity & Interference Defense Suite", () => {
		testSequentialEdits();
		testExternalMutationDefense();
	});
}

