// Aliased Re-exports & Multi-line Signatures Suite

import { runSuite } from "../_setup";
import { testAliasedReExports } from "./alias_test";

export async function run(): Promise<void> {
	await runSuite("Aliased Re-exports & Multi-line Signatures Suite", async () => {
		await testAliasedReExports();
	});
}

