import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerEditTool, withFileMutationLocks } from "../../src/tools/edit_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(): Promise<void> {
  console.log("=== Running File Mutation Concurrency Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-concurrency-"));
  const session = "mutation-concurrency";
  globalEpistemicGuard.resetSession(session);
  try {
    const same = path.join(base, "same.txt");
    let active = 0;
    let maxActive = 0;
    await Promise.all([
      withFileMutationLocks([same], async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(25);
        active--;
      }),
      withFileMutationLocks([same], async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(25);
        active--;
      }),
    ]);
    assert.equal(maxActive, 1, "same-path mutations must serialize");

    const a = path.join(base, "a.txt");
    const b = path.join(base, "b.txt");
    await Promise.race([
      Promise.all([
        withFileMutationLocks([b, a], async () => delay(20)),
        withFileMutationLocks([a, b], async () => delay(20)),
      ]),
      delay(3000).then(() => { throw new Error("multi-path lock ordering deadlocked"); }),
    ]);

    const file = path.join(base, "sample.ts");
    fs.writeFileSync(
      file,
      "export const first = 1;\nexport const second = 2;\n",
      "utf8",
    );
    globalEpistemicGuard.recordFileRead(file, session, base, fs.readFileSync(file, "utf8"), {
      coverage: { complete: true, ranges: [] },
    });
    let editTool: any;
    const config: any = {
      safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
      editing: { default_anchors: false, read_mode: "plain" },
    };
    registerEditTool({ registerTool(tool: any) { editTool = tool; } } as any, {
      getSessionId: () => session,
      getConfig: () => config,
      invalidateSearchFile() {},
    });
    const [first, second] = await Promise.all([
      editTool.execute("first", { path: file, search: "first = 1;", replace: "first = 10;" }, null, () => {}, { cwd: base }),
      editTool.execute("second", { path: file, search: "second = 2;", replace: "second = 20;" }, null, () => {}, { cwd: base }),
    ]);
    assert.equal(Boolean(first.isError), false, JSON.stringify(first));
    assert.equal(Boolean(second.isError), false, JSON.stringify(second));
    const final = fs.readFileSync(file, "utf8");
    assert.match(final, /first = 10/);
    assert.match(final, /second = 20/);

    console.log("✓ Same-path edits serialize, lock ordering is deterministic, and parallel edits do not overwrite!");
  } finally {
    globalEpistemicGuard.resetSession(session);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
