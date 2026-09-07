// Section 3: Repository Map & PageRank Suite
// Modular tests for polyglot repository mapping and token budget clamping.

import { runSection } from "../_setup";
import { testPolyglotRepoMap } from "./polyglot_map_test";
import { testBudgetClamping } from "./budget_test";

export async function runSection03(): Promise<void> {
	await runSection("3. Repository Map & PageRank Suite", async () => {
		await testPolyglotRepoMap();
		testBudgetClamping();
	});
}

runSection03().catch((err) => {
	console.error(err);
	process.exit(1);
});
