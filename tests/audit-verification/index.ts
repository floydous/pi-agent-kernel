// Post-Fix Verification Audit Suite
// Modular tests for cache invalidation and repomap cold start.

import { runSuite } from "../_setup";
import { testStaleCacheRejection } from "./stale_cache_test";
import { testRepomapColdStart } from "./repomap_cold_test";

export async function run(): Promise<void> {
	await runSuite("Post-Fix Verification Audit Suite", async () => {
		await testStaleCacheRejection();
		await testRepomapColdStart();
	});
}

