import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerEditTool } from "../../src/tools/edit_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";

async function runEdit(cwd: string, mode: "smart_anchor" | "standard", file: string) {
  const source = fs.readFileSync(file, "utf8");
  globalEpistemicGuard.recordFileRead(file, mode, cwd, source, { coverage: { complete: true, ranges: [] } });
  let tool: any;
  const config: any = {
    safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
    editing: { mode, read_mode: "plain", default_anchors: false },
  };
  registerEditTool({ registerTool(registered: any) { tool = registered; } } as any, {
    getSessionId: () => mode,
    getConfig: () => config,
    invalidateSearchFile() {},
  });
  return tool.execute(
    mode,
    { path: file, search: '"a": 1', replace: '"a": 2' },
    null,
    () => {},
    { cwd },
  );
}

export async function run(): Promise<void> {
  console.log("=== Running Editing Mode Contract Tests ===");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editing-mode-"));
  try {
    const smartFile = path.join(root, "smart.json");
    fs.writeFileSync(smartFile, '{"a": 1', "utf8");
    const smart = await runEdit(root, "smart_anchor", smartFile);
    assert.notEqual(smart.isError, true, "smart_anchor may heal a truncated JSON replacement");
    assert.match(fs.readFileSync(smartFile, "utf8"), /\}\s*$/);

    const standardFile = path.join(root, "standard.json");
    fs.writeFileSync(standardFile, '{"a": 1', "utf8");
    const standard = await runEdit(root, "standard", standardFile);
    assert.equal(standard.isError, true, "standard mode must not auto-heal missing delimiters");
    assert.equal(fs.readFileSync(standardFile, "utf8"), '{"a": 1', "standard failure must leave disk unchanged");

    console.log("! Smart-anchor healing and standard fail-closed editing behavior match the UI contract!");
  } finally {
    globalEpistemicGuard.resetSession("smart_anchor");
    globalEpistemicGuard.resetSession("standard");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
