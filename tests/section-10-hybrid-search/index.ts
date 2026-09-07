// Section 10: Hybrid AST Code Search Engine Suite
// Modular tests for chunking, indexing, retrieval, RRF, and cache invalidation.

import { runSection } from "../_setup";
import { testChunking } from "./chunking_test";
import { testIndexStatus } from "./index_status_test";
import { testSearchRetrieval } from "./search_retrieval_test";
import { testRrfAndAbstain } from "./rrf_abstain_test";
import { testCacheInvalidation } from "./cache_invalidation_test";

export async function runSection10(): Promise<void> {
	await runSection("10. Hybrid AST Code Search Engine Suite", async () => {
		testChunking();
		await testIndexStatus();
		await testSearchRetrieval();
		await testRrfAndAbstain();
		await testCacheInvalidation();
	});
}

runSection10().catch((err) => {
	console.error(err);
	process.exit(1);
});
