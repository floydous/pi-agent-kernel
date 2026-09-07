// End-to-End Dedup Hook Suite

import { runSuite } from "../_setup";
import { testE2EDedupHook } from "./e2e_test";

export async function run(): Promise<void> {
	await runSuite("End-to-End Dedup Hook Suite", () => {
		testE2EDedupHook();
	});
}

