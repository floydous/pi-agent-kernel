import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { registerEditTool } from "../../src/tools/edit_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";

export async function run(): Promise<void> {
  console.log("=== Running Shell Paging Evidence Tests ===");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paging-evidence-"));
  const deniedSession = "paging-denied";
  const allowedSession = "paging-allowed";
  globalEpistemicGuard.resetSession(deniedSession);
  globalEpistemicGuard.resetSession(allowedSession);
  try {
    const file = path.join(cwd, "sample.ts");
    const source = [
      "export const visible = 1;",
      "export const hidden = 2;",
      "export const third = 3;",
    ].join("\n");
    fs.writeFileSync(file, source, "utf8");

    let editTool: any;
    const config: any = {
      safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
      editing: { default_anchors: false, read_mode: "plain" },
    };
    registerEditTool({ registerTool(tool: any) { editTool = tool; } } as any, {
      getSessionId: () => deniedSession,
      getConfig: () => config,
      invalidateSearchFile() {},
    });

    globalEpistemicGuard.recordCommandExecution(
      `head -n 2 "${file}" > /dev/null`,
      cwd,
      deniedSession,
      false,
      "",
    );
    const denied = await editTool.execute(
      "denied",
      { path: file, search: "hidden = 2;", replace: "hidden = 22;" },
      null,
      () => {},
      { cwd },
    );
    assert.equal(denied.isError, true, "redirected head must not authorize hidden lines");
    assert.equal(fs.readFileSync(file, "utf8"), source);

    const actualHead = source.split("\n").slice(0, 2).join("\n");
    globalEpistemicGuard.recordCommandExecution(
      `head -n 2 "${file}"`,
      cwd,
      allowedSession,
      true,
      actualHead,
    );
    const actualEvidence = globalEpistemicGuard.getEvidence(file, allowedSession, cwd);
    assert.equal(actualEvidence?.kind, "read");
    assert.deepEqual(actualEvidence?.coverage.ranges, [{ startLine: 1, endLine: 2 }]);

    const synthetic = new EpistemicGuard();
    synthetic.recordCommandExecution(
      `printf '1:fake\\n' | head -n 1 "${file}"`,
      cwd,
      "synthetic",
      false,
      "1:fake",
    );
    const syntheticEvidence = synthetic.getEvidence(file, "synthetic", cwd);
    assert.ok(
      !syntheticEvidence || syntheticEvidence.kind !== "read" || syntheticEvidence.coverage.ranges.length === 0,
      "synthetic output must not become read evidence",
    );

    console.log("! Empty, redirected, and synthetic head output grants no hidden edit evidence!");
  } finally {
    globalEpistemicGuard.resetSession(deniedSession);
    globalEpistemicGuard.resetSession(allowedSession);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
