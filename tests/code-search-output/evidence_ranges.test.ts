import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCodeSearchTool } from "../../src/tools/code_search_tool";
import { registerEditTool } from "../../src/tools/edit_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";
import {
  formatCodeSearchResults,
  type FormattedCodeSearchResults,
} from "../../src/tools/code_search_output";
import type { SearchHit } from "../../src/retrieval/search_index";

function hit(filePath: string, content: string): SearchHit {
  const lines = content.split("\n");
  return {
    chunk: {
      id: `${path.basename(filePath)}:1-${lines.length}#file`,
      filePath,
      absolutePath: filePath,
      startLine: 1,
      endLine: lines.length,
      symbolName: "file",
      kind: "file",
      signature: "File",
      breadcrumb: `// [File: ${path.basename(filePath)}]`,
      content,
      textForEmbedding: content.slice(0, 1500),
      hash: "unused",
    },
    rrfScore: 1,
    bm25Score: 1,
    vectorScore: 0,
    signal: "lexical",
    matches: ["query"],
  };
}

export async function run(): Promise<void> {
  console.log("=== Running Code Search Evidence Range Tests ===");
  const shortSource = Array.from({ length: 10 }, (_, i) => `export const value${i} = ${i};`).join("\n");
  const short = hit("short.ts", shortSource);
  const shortFormatted: FormattedCodeSearchResults = formatCodeSearchResults([short], "value5", "preview");
  assert.deepEqual(shortFormatted.visibleRanges, [{ chunkId: short.chunk.id, startLine: 1, endLine: 10 }]);

  const fullFormatted = formatCodeSearchResults([short], "value5", "full");
  assert.deepEqual(fullFormatted.visibleRanges, [{ chunkId: short.chunk.id, startLine: 1, endLine: 10 }]);
  const summaryFormatted = formatCodeSearchResults([short], "value5", "summary");
  assert.deepEqual(summaryFormatted.visibleRanges, []);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "search-evidence-"));
  const session = "search-evidence";
  globalEpistemicGuard.resetSession(session);
  try {
    const file = path.join(base, "large.ts");
    const longLines = Array.from({ length: 95 }, (_, i) => `// broad context ${i} ${"x".repeat(120)}`);
    const source = [
      ...longLines,
      "export const near96 = 96;",
      "export const hidden98 = 98;",
      "export const hidden99 = 99;",
    ].join("\n");
    fs.writeFileSync(file, source, "utf8");
    const result = hit("large.ts", source);
    let registeredSearch: any;
    let registeredEdit: any;
    const config: any = {
      retrieval: { max_search_results: 5 },
      safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
      editing: { default_anchors: false, read_mode: "plain" },
    };
    registerCodeSearchTool({ registerTool(tool: any) { registeredSearch = tool; } } as any, {
      getSessionId: () => session,
      getConfig: () => config,
      getSearchIndex: () => ({
        search: async () => [result],
        getStatus: () => ({ effectiveProfile: "lean", vectorCount: 0, chunkCount: 1 }),
      }) as any,
    });
    registerEditTool({ registerTool(tool: any) { registeredEdit = tool; } } as any, {
      getSessionId: () => session,
      getConfig: () => config,
      invalidateSearchFile() {},
    });

    const search = await registeredSearch.execute("search", { query: "broad context 50" }, null, () => {}, { cwd: base });
    assert.equal(search.content[0].text.includes("hidden99"), false);
    const edit = await registeredEdit.execute(
      "edit",
      { path: file, search: "hidden99 = 99;", replace: "hidden99 = 999;" },
      null,
      () => {},
      { cwd: base },
    );
    assert.equal(edit.isError, true, "a clipped preview must not authorize an unseen line");
    assert.equal(fs.readFileSync(file, "utf8").includes("hidden99 = 99"), true);
    const evidence = globalEpistemicGuard.getEvidence(file, session, base);
    assert.equal(evidence?.kind, "search");
    assert.deepEqual(evidence?.coverage.ranges, []);

    console.log("✓ Preview, full, summary, clipping, and hidden-line edit authorization are exact!");
  } finally {
    globalEpistemicGuard.resetSession(session);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
