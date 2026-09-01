import * as fs from "node:fs";
import * as path from "node:path";
import { HybridSearchIndex } from "../src/retrieval/search_index";
import { LocalEmbedder } from "../src/retrieval/search_embedder";
import { getSearchConfig } from "../src/retrieval/search_config";
import { formatDocumentSymbols } from "../src/lsp/lsp_formatter";
import { buildChronologicalCompactionPrompt, buildCompactionSystemPrompt } from "../src/context/compaction_enhanced";
import { LspSymbolKind } from "../src/lsp/lsp_types";

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
    assert(fs.existsSync(path.join(testWorkspaceDir, ".pi", "cache", "search", "index.json")), "index.json written to disk");

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

  // 2. TEST BOUNDED DOCUMENT SYMBOLS FORMATTER
  console.log("\n[2. Testing Bounded Document Symbols Formatter]");
  
  // Test empty
  assert(formatDocumentSymbols(null) === "No symbols found.", "Handles null symbols");
  assert(formatDocumentSymbols([]) === "No symbols found.", "Handles empty symbols array");

  // Test normal small set
  const smallSymbols: any[] = [
    { name: "MyClass", kind: LspSymbolKind.Class, range: { start: { line: 0, character: 0 } } },
    { name: "myMethod", kind: LspSymbolKind.Method, range: { start: { line: 5, character: 2 } } },
  ];
  const formattedSmall = formatDocumentSymbols(smallSymbols);
  assert(formattedSmall.includes("1: [class] MyClass"), "Formats class symbol correctly");
  assert(formattedSmall.includes("6: [method] myMethod"), "Formats method symbol with 1-based index");
  assert(!formattedSmall.includes("Truncated"), "Small symbol list is not truncated");

  // Test large monolithic set (>100 symbols)
  const largeSymbols: any[] = [];
  for (let i = 0; i < 150; i++) {
    largeSymbols.push({
      name: `func_${i}`,
      kind: LspSymbolKind.Function,
      range: { start: { line: i * 2, character: 0 } },
      detail: `fn() -> i32`,
    });
  }
  const formattedLarge = formatDocumentSymbols(largeSymbols);
  assert(formattedLarge.includes("[Truncated: 100/150 symbols shown]"), "Truncates output when >100 symbols");
  const symbolLines = formattedLarge.split("\n").filter((l) => l.includes("[function]"));
  assert(symbolLines.length === 100, `Outputs exactly 100 symbols before truncation notice (got ${symbolLines.length})`);

  // 3. TEST COMPACTION PROMPT PREFIX STABILITY & SYSTEM PROMPT SEPARATION
  console.log("\n[3. Testing Compaction Prompt Prefix Stability]");
  const sysPrompt = buildCompactionSystemPrompt();
  assert(sysPrompt.length > 500, "System prompt contains complete static summarization instructions");
  assert(sysPrompt.includes("CRITICAL INSTRUCTIONS FOR CHRONOLOGICAL RECONCILIATION"), "Contains grounding constraints");

  const prompt1 = buildChronologicalCompactionPrompt({
    previousSummary: "## Goal: Test",
    discardedConversationText: "Turn 1: user hello",
    recentTrajectoryDigest: "<recent>digest</recent>",
    workspaceState: "<workspace-state>file: index.ts</workspace-state>",
  });

  const prompt2 = buildChronologicalCompactionPrompt({
    previousSummary: "## Goal: Test",
    discardedConversationText: "Turn 1: user hello",
    recentTrajectoryDigest: "<recent>digest</recent>",
    workspaceState: "<workspace-state>file: index.ts\nfile: added.ts</workspace-state>",
  });

  // Verify prefix stability up to the dynamic workspaceState at the tail
  const prefixUpToWorkspace = prompt1.slice(0, prompt1.indexOf("<workspace-state>"));
  assert(prompt2.startsWith(prefixUpToWorkspace), "User message prompt prefix is strictly stable across workspace changes");
  assert(prompt1.endsWith("</workspace-state>\n\n"), "Dynamic workspace state sits cleanly at prompt tail");

  console.log("\n=== TEST RESULTS SUMMARY ===");
  if (failed === 0) {
    console.log("✅ ALL INTENSIVE TESTS PASSED WITH ZERO ERRORS!");
    return;
  } else {
    throw new Error(`${failed} TEST(S) FAILED!`);
  }
}

export const runPromise = runIntensiveTests();
