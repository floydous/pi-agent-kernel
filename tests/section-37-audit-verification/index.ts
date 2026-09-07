// Section 37: Post-Fix Verification Audit Suite
// Modular tests for cache invalidation, repomap cold start, and LSP dual-directory lookup.

import { runSection } from "../_setup";
import { testStaleCacheRejection } from "./stale_cache_test";
import { testRepomapColdStart } from "./repomap_cold_test";
import { testLspDualDirLookup } from "./lsp_dual_dir_test";

export async function runSection37(): Promise<void> {
	await runSection("37. Post-Fix Verification Audit Suite", async () => {
		await testStaleCacheRejection();
		await testRepomapColdStart();
		testLspDualDirLookup();
	});
}

runSection37().catch((err) => {
	console.error(err);
	process.exit(1);
});
