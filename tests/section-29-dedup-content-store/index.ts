// Section 29: Content-Addressed Dedup Suite

import { runSection } from "../_setup";
import {
	testFirstOccurrencePassThrough,
	testByteEqualityDedup,
	testBelowThresholdNotDeduped,
	testSessionIsolation,
	testRecallRetrieval,
} from "./dedup_test";

export async function runSection29(): Promise<void> {
	await runSection("29. Content-Addressed Dedup Suite", () => {
		testFirstOccurrencePassThrough();
		testByteEqualityDedup();
		testBelowThresholdNotDeduped();
		testSessionIsolation();
		testRecallRetrieval();
	});
}

runSection29().catch((err) => {
	console.error(err);
	process.exit(1);
});
