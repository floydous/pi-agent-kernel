// Post-Fix Verification Audit Suite
// Modular tests for cache invalidation, repomap cold start, and LSP dual-directory lookup.

import { runSuite } from "../_setup";
import { testStaleCacheRejection } from "./stale_cache_test";
import { testRepomapColdStart } from "./repomap_cold_test";
import { testLspDualDirLookup } from "./lsp_dual_dir_test";

export async function run(): Promise<void> {
	await runSuite("Post-Fix Verification Audit Suite", async () => {
		await testStaleCacheRejection();
		await testRepomapColdStart();
		testLspDualDirLookup();
	});
}

