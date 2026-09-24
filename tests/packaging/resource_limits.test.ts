import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { MAX_INDEX_FILE_BYTES, MAX_INDEX_WORKSPACE_BYTES, chunkFile } from "../../src/retrieval/search_chunker";
import { registerReadTool } from "../../src/tools/read_tool";

function sparseFile(filePath: string, bytes: number): void {
  const fd = fs.openSync(filePath, "w");
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

export async function run(): Promise<void> {
  console.log("=== Running Read and Index Resource Budget Tests ===");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-budget-"));
  const previousPiDir = process.env.PI_DIR;
  process.env.PI_DIR = path.join(root, "pi");
  try {
    const oversized = path.join(root, "huge.ts");
    sparseFile(oversized, 5 * 1024 * 1024 + 1);
    assert.deepEqual(chunkFile(root, oversized), [], "chunkFile must reject oversized source before parsing");
    assert.equal(fs.readFileSync(oversized, "utf8").length, 5 * 1024 * 1024 + 1);

    let readTool: any;
    registerReadTool({ registerTool(tool: any) { readTool = tool; } } as any, {
      getSessionId: () => "resource-budget",
      getConfig: () => ({ safety: { max_total_bytes: 20 * 1024 }, editing: { read_mode: "plain", default_anchors: false } }) as any,
    });
    const rejected = await readTool.execute("read", { path: oversized }, null, () => {}, { cwd: root });
    assert.equal(rejected.isError, true, JSON.stringify(rejected));
    assert.match(rejected.content[0].text, /maximum in-memory source size/);

    const index = new HybridSearchIndex(root, "lean");
    const result = await index.syncWorkspace(true);
    const status = index.getStatus();
    assert.equal(result.fileCount, 0);
    assert.equal(status.fileCount, 0);
    assert.ok(status.skippedFiles >= 1, "oversized files must be reported as skipped");
    await index.flushPendingSave(true);

    for (let i = 0; i < 25; i++) {
      sparseFile(path.join(root, `aggregate-${String(i).padStart(2, "0")}.ts`), 1024 * 1024);
    }
    const aggregateIndex = new HybridSearchIndex(root, "lean");
    const aggregateResult = await aggregateIndex.syncWorkspace(true);
    const aggregateStatus = aggregateIndex.getStatus();
    assert.ok(aggregateResult.fileCount < 25, "aggregate byte budget must skip files");
    assert.ok(aggregateStatus.skippedFiles >= 1, "aggregate skips must be visible in status");
    assert.ok(MAX_INDEX_WORKSPACE_BYTES >= MAX_INDEX_FILE_BYTES);
    await aggregateIndex.flushPendingSave(true);

    console.log("! Oversized reads, per-file index limits, aggregate bytes, and skip diagnostics are bounded!");
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
