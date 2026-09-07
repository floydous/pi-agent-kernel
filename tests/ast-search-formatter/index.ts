// Hierarchical AST Search Formatter Suite
// Modular tests for the pure ast_search_formatter covering layout, signatures, body, and edges.

import { runSuite } from "../_setup";
import { testBasicGroupingAndLayout } from "./grouping_test";
import { testSignatureCleaning } from "./signature_cleaning_test";
import { testBodyAndTruncation } from "./body_truncation_test";
import { testAliasAndEdgeCases } from "./alias_edge_test";
import { testToolIntegrationWithEpistemicGuard } from "./tool_integration_test";

export async function run(): Promise<void> {
	await runSuite("Hierarchical AST Search Formatter Suite", async () => {
		testBasicGroupingAndLayout();
		testSignatureCleaning();
		testBodyAndTruncation();
		testAliasAndEdgeCases();
		await testToolIntegrationWithEpistemicGuard();
	});
}

