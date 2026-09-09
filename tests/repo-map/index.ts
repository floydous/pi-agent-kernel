// Repository Map & PageRank Suite
// Modular tests for polyglot repository mapping and token budget clamping.

import { runSuite } from "../_setup";
import { testPolyglotRepoMap } from "./polyglot_map_test";
import { testBudgetClamping } from "./budget_test";
import { testAdaptiveRepoMapThreshold } from "./adaptive_threshold_test";

export async function run(): Promise<void> {
	await runSuite("Repository Map & PageRank Suite", async () => {
		await testPolyglotRepoMap();
		testBudgetClamping();
		await testAdaptiveRepoMapThreshold();
	});
}

