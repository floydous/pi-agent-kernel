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

    // Test apply-and-warn in smart_anchor mode
    const tsFile = path.join(root, "warning.ts");
    fs.writeFileSync(tsFile, "export const x = 1;\n", "utf8");
    globalEpistemicGuard.recordFileRead(tsFile, "smart_anchor", root, "export const x = 1;\n", { coverage: { complete: true, ranges: [] } });
    let tool: any;
    const config: any = {
      safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
      editing: { mode: "smart_anchor", read_mode: "plain", default_anchors: false, syntax_gate: "warn" },
    };
    registerEditTool({ registerTool(registered: any) { tool = registered; } } as any, {
      getSessionId: () => "smart_anchor",
      getConfig: () => config,
      invalidateSearchFile() {},
    });
    const warnRes = await tool.execute(
      "smart_anchor",
      { path: tsFile, search: "export const x = 1;", replace: "export const x = 1; function (" },
      null,
      () => {},
      { cwd: root },
    );
    assert.equal(warnRes.isError, false, "syntax warnings should not block edit application");
    assert.equal(fs.readFileSync(tsFile, "utf8"), "export const x = 1; function (\n", "candidate content must be saved to disk");
    assert.match(warnRes.content[0].text, /Syntax Error:/, "syntax error must be clearly reported in output");

    console.log("! Smart-anchor healing, apply-and-warn, and standard fail-closed editing behavior match the UI contract!");
  } finally {
    globalEpistemicGuard.resetSession("smart_anchor");
    globalEpistemicGuard.resetSession("standard");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
