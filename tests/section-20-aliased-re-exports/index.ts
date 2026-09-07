// Section 20: Aliased Re-exports & Multi-line Signatures Suite

import { runSection } from "../_setup";
import { testAliasedReExports } from "./alias_test";

export async function runSection20(): Promise<void> {
	await runSection("20. Aliased Re-exports & Multi-line Signatures Suite", async () => {
		await testAliasedReExports();
	});
}

runSection20().catch((err) => {
	console.error(err);
	process.exit(1);
});
