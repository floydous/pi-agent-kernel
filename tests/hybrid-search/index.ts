// Hybrid AST Code Search Engine Suite
// Modular tests for chunking, indexing, retrieval, RRF, and cache invalidation.

import { runSuite } from "../_setup";
import { testChunking } from "./chunking_test";
import { testIndexStatus } from "./index_status_test";
import { testSearchRetrieval } from "./search_retrieval_test";
import { testRrfAndAbstain } from "./rrf_abstain_test";
import { testCacheInvalidation } from "./cache_invalidation_test";

export async function run(): Promise<void> {
	await runSuite("Hybrid AST Code Search Engine Suite", async () => {
		testChunking();
		await testIndexStatus();
		await testSearchRetrieval();
		await testRrfAndAbstain();
		await testCacheInvalidation();
	});
}

