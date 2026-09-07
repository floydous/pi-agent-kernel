// Section 31: End-to-End Dedup Hook Suite

import { runSection } from "../_setup";
import { testE2EDedupHook } from "./e2e_test";

export async function runSection31(): Promise<void> {
	await runSection("31. End-to-End Dedup Hook Suite", () => {
		testE2EDedupHook();
	});
}

runSection31().catch((err) => {
	console.error(err);
	process.exit(1);
});
