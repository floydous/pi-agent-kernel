// Content-Addressed Dedup Suite

import { runSuite } from "../_setup";
import {
	testFirstOccurrencePassThrough,
	testByteEqualityDedup,
	testBelowThresholdNotDeduped,
	testSessionIsolation,
	testRecallRetrieval,
} from "./dedup_test";

export async function run(): Promise<void> {
	await runSuite("Content-Addressed Dedup Suite", () => {
		testFirstOccurrencePassThrough();
		testByteEqualityDedup();
		testBelowThresholdNotDeduped();
		testSessionIsolation();
		testRecallRetrieval();
	});
}

