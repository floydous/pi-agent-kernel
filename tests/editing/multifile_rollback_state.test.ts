import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerEditTool } from "../../src/tools/edit_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";

export async function run(): Promise<void> {
  console.log("=== Running Multi-File Rollback State Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "multifile-rollback-"));
  const config: any = {
    safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
    editing: { default_anchors: false, read_mode: "plain" },
  };

  async function runCase(session: string, failRollbackIndex: boolean) {
    globalEpistemicGuard.resetSession(session);
    const a = path.join(base, `${session}-a.ts`);
    const b = path.join(base, `${session}-b.ts`);
    const aSource = "export const a = 1;\n";
    const bSource = "export const b = 1;\n";
    fs.writeFileSync(a, aSource, "utf8");
    fs.writeFileSync(b, bSource, "utf8");
    globalEpistemicGuard.recordFileRead(a, session, base, aSource, {
      coverage: { complete: true, ranges: [] },
    });
    globalEpistemicGuard.recordFileRead(b, session, base, bSource, {
      coverage: { complete: true, ranges: [] },
    });

    const invalidations: string[] = [];
    let tool: any;
    registerEditTool({ registerTool(registered: any) { tool = registered; } } as any, {
      getSessionId: () => session,
      getConfig: () => config,
      async invalidateSearchFile(_cwd, file) {
        invalidations.push(path.basename(file));
        if (failRollbackIndex && invalidations.length === 2) {
          throw new Error("index rollback unavailable");
        }
      },
    });
    const result = await tool.execute(
      "multi",
      {
        files: [
          { path: a, search: "= 1;", replace: "= 2;" },
          { path: b, search: "= 1;", replace: "= broken {{{" },
        ],
      },
      null,
      () => {},
      { cwd: base },
    );
    return { a, b, aSource, bSource, result, invalidations };
  }

  try {
    const restored = await runCase("rollback-complete", false);
    assert.equal(restored.result.isError, true);
    assert.match(restored.result.content[0].text, /ROLLED BACK/);
    assert.doesNotMatch(restored.result.content[0].text, /PARTIAL/);
    assert.equal(fs.readFileSync(restored.a, "utf8"), restored.aSource);
    assert.deepEqual(restored.invalidations, ["rollback-complete-a.ts", "rollback-complete-a.ts"]);
    const guard = globalEpistemicGuard.checkReadPrecondition(
      restored.a,
      "edit",
      "rollback-complete",
      base,
      true,
      [{ startLine: 1, endLine: 1 }],
      ["= 1;"],
    );
    assert.equal(guard.allowed, true, "guard evidence must be restored after disk rollback");
    globalEpistemicGuard.resetSession("rollback-complete");

    const partial = await runCase("rollback-partial", true);
    assert.equal(partial.result.isError, true);
    assert.match(partial.result.content[0].text, /PARTIAL ROLLBACK/);
    assert.match(partial.result.content[0].text, /index rollback unavailable/);
    assert.equal(fs.readFileSync(partial.a, "utf8"), partial.aSource, "disk remains authoritative after partial report");
    globalEpistemicGuard.resetSession("rollback-partial");

    console.log("✓ Complete rollback restores disk/index/guard state; secondary failures report partial recovery!");
  } finally {
    globalEpistemicGuard.resetSession("rollback-complete");
    globalEpistemicGuard.resetSession("rollback-partial");
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
