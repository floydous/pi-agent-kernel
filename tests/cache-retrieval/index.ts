import * as fs from "node:fs";
import * as path from "node:path";
import { HybridSearchIndex, getSearchCacheDir } from "../../src/retrieval/search_index";
import { LocalEmbedder } from "../../src/retrieval/search_embedder";
import { getSearchConfig } from "../../src/retrieval/search_config";

async function runIntensiveTests() {
  console.log("=== STARTING INTENSIVE CACHE & RETRIEVAL VERIFICATION ===");
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`❌ FAIL: ${msg}`);
      failed++;
    } else {
      console.log(`✓ PASS: ${msg}`);
    }
  }

  // 1. TEST LOCAL EMBEDDER LRU CACHE
  console.log("\n[1. Testing LocalEmbedder Query LRU Cache]");
  const config = getSearchConfig("lean"); // using lean profile for unit check of cache wrapper
  const embedder = new LocalEmbedder(config);

  // Mock embedBatch to track actual calls
  let batchCalls = 0;
  (embedder as any).embedBatch = async (texts: string[], isQuery = false) => {
    batchCalls++;
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
  };

  // Test first query embedding (cache miss)
  const vec1 = await embedder.embed("query alpha", true);
  assert(batchCalls === 1, "First query causes embedBatch execution");
  assert(vec1 !== null && vec1.length === 4, "Returns valid embedding vector");

  // Test repeat query (cache hit)
  const vec2 = await embedder.embed("query alpha", true);
  assert(batchCalls === 1, "Repeat query returns cached vector without embedBatch call");
  assert(vec1 === vec2, "Cached vector reference matches");

  // Non-query embedding should NOT cache
  const docVec1 = await embedder.embed("query alpha", false);
  assert(batchCalls === 2, "Document embedding is not cached in query LRU");

  // Fill LRU cache to capacity (128) + 1 to test eviction
  for (let i = 0; i < 130; i++) {
    await embedder.embed(`test query ${i}`, true);
  }
  // The first inserted query (test query 0) should have been evicted
  const callsBefore = batchCalls;
  await embedder.embed("test query 0", true);
  assert(batchCalls === callsBefore + 1, "Evicted entry triggers embedBatch again");

  // Most recent entry should still be cached
  await embedder.embed("test query 129", true);
  assert(batchCalls === callsBefore + 1, "Recent entry remains cached");

  // Test updateConfig clears cache
  embedder.updateConfig(getSearchConfig("lean"));
  await embedder.embed("test query 129", true);
  assert(batchCalls === callsBefore + 2, "updateConfig clears query cache");

  // Test dispose clears cache
  await embedder.dispose();
  assert((embedder as any).queryLruCache.size === 0, "dispose clears query cache map");

  // 1.1 TEST INCREMENTAL HYBRIDSEARCHINDEX STARTUP DISK CACHE REUSE
  console.log("\n[1.1 Testing HybridSearchIndex Startup Disk Cache Reuse]");
  const testWorkspaceDir = path.resolve(__dirname, "temp_search_cache_test");
  if (fs.existsSync(testWorkspaceDir)) {
    fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testWorkspaceDir, { recursive: true });
  fs.writeFileSync(path.join(testWorkspaceDir, "sample.ts"), "export function helloWorld(): string { return 'hi'; }\n", "utf8");

  try {
    const idx1 = new HybridSearchIndex(testWorkspaceDir, "lean");
    const res1 = await idx1.syncWorkspace(false);
    assert(res1.chunkCount > 0, "Initial sync workspace creates chunks in cache");
    assert(fs.existsSync(path.join(getSearchCacheDir(testWorkspaceDir), "index.json")), "index.json written to disk");

    // Startup scenario: instantiate new HybridSearchIndex on existing cached directory without force reindex
    const idx2 = new HybridSearchIndex(testWorkspaceDir, "lean");
    let batchEmbedCalled = false;
    (idx2 as any).embedder.embedBatch = async () => {
      batchEmbedCalled = true;
      return [];
    };

    const res2 = await idx2.syncWorkspace(false);
    assert(res2.chunkCount === res1.chunkCount, "Incremental sync reuses disk chunks");
    assert(!batchEmbedCalled, "Unchanged files bypass embedding batch execution on startup");
  } finally {
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
  }

  console.log("\n=== TEST RESULTS SUMMARY ===");
  if (failed === 0) {
    console.log("✅ ALL INTENSIVE TESTS PASSED WITH ZERO ERRORS!");
    return;
  } else {
    throw new Error(`${failed} TEST(S) FAILED!`);
  }
}

export async function run(): Promise<void> {
	await runIntensiveTests();
}

