import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerEditTool } from "../../src/tools/edit_tool";
import { registerReadTool } from "../../src/tools/read_tool";
import { loadKernelConfig, mergeKernelConfig } from "../../src/config";

export async function run(): Promise<void> {
  console.log("=== Running Fullwidth Dot Normalization Tests ===");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "normalize-dots-test-"));
  const testFile = path.join(tmpDir, "sample.py");
  const testFileRel = "sample.py";

  let readToolDef: any;
  let editToolDef: any;

  const mockPi: any = {
    registerTool: (tool: any) => {
      if (tool.name === "read") readToolDef = tool;
      if (tool.name === "edit") editToolDef = tool;
    },
  };

  let configOverride: any = {};
  const deps: any = {
    getSessionId: () => "test-session-dots",
    getConfig: () => mergeKernelConfig(loadKernelConfig(tmpDir), configOverride),
    invalidateSearchFile: async () => {},
  };

  registerReadTool(mockPi, deps);
  registerEditTool(mockPi, deps);

  const mockCtx = { cwd: tmpDir };

  try {
    // 1. Single-block edit: replace with \uff0e is normalized to .
    fs.writeFileSync(testFile, 'import os.path\nprint("hello")\n', "utf8");
    await readToolDef.execute("r1", { path: testFileRel }, undefined, undefined, mockCtx);

    const inputItem1 = {
      path: testFileRel,
      search: "import os.path",
      replace: "import os\uff0epath\nimport sys",
    };
    const res1 = await editToolDef.execute("e1", inputItem1, undefined, undefined, mockCtx);

    assert.equal(res1.isError, false, `Edit should succeed: ${res1.content?.[0]?.text}`);
    const content1 = fs.readFileSync(testFile, "utf8");
    assert.ok(content1.includes("import os.path"), "Should have written ASCII '.'");
    assert.ok(!content1.includes("\uff0e"), "Should not contain U+FF0E");
    // Verify caller input object was not mutated in place
    assert.equal(inputItem1.replace, "import os\uff0epath\nimport sys", "Caller input object must not be mutated");

    // 2. Single-block edit: search with \uff0e matches file containing ASCII .
    await readToolDef.execute("r2", { path: testFileRel }, undefined, undefined, mockCtx);

    const res2 = await editToolDef.execute(
      "e2",
      {
        path: testFileRel,
        search: "import os\uff0epath",
        replace: "import os.path\nimport math",
      },
      undefined,
      undefined,
      mockCtx,
    );

    assert.equal(res2.isError, false, `Edit with fullwidth dot search should succeed: ${res2.content?.[0]?.text}`);
    const content2 = fs.readFileSync(testFile, "utf8");
    assert.ok(content2.includes("import math"), "Should have matched and replaced");

    // 3. Multi-block edit: blocks with multiple \uff0e are normalized globally
    await readToolDef.execute("r3", { path: testFileRel }, undefined, undefined, mockCtx);

    const res3 = await editToolDef.execute(
      "e3",
      {
        path: testFileRel,
        edits: [
          {
            search: "import math",
            replace: "import math\nimport a\uff0eb\uff0ec\uff0ed",
          },
        ],
      },
      undefined,
      undefined,
      mockCtx,
    );

    assert.equal(res3.isError, false, `Multi-block edit should succeed: ${res3.content?.[0]?.text}`);
    const content3 = fs.readFileSync(testFile, "utf8");
    assert.ok(content3.includes("import a.b.c.d"), "Multiple U+FF0E must all be converted to ASCII '.' globally");
    assert.ok(!content3.includes("\uff0e"), "Multi-block should not contain U+FF0E");

    // 4. Smart-anchor edit: lines with \uff0e are normalized
    await readToolDef.execute("r4", { path: testFileRel }, undefined, undefined, mockCtx);

    const linesInput = ["import os\uff0epath as osp"];
    const res4 = await editToolDef.execute(
      "e4",
      {
        path: testFileRel,
        pos: 1,
        end: 1,
        lines: linesInput,
      },
      undefined,
      undefined,
      mockCtx,
    );

    assert.equal(res4.isError, false, `Smart-anchor edit should succeed: ${res4.content?.[0]?.text}`);
    const content4 = fs.readFileSync(testFile, "utf8");
    assert.ok(content4.includes("import os.path as osp"), "Anchor lines should have normalized to ASCII .");
    assert.ok(!content4.includes("\uff0e"), "Anchor lines should not contain U+FF0E");
    assert.equal(linesInput[0], "import os\uff0epath as osp", "Caller input lines array must not be mutated");

    // 5. When normalize_fullwidth_dots = false, U+FF0E is preserved verbatim on write
    configOverride = { editing: { normalize_fullwidth_dots: false } };
    await readToolDef.execute("r5", { path: testFileRel }, undefined, undefined, mockCtx);

    const res5 = await editToolDef.execute(
      "e5",
      {
        path: testFileRel,
        search: "import math",
        replace: "import math # literal_\uff0e_here",
      },
      undefined,
      undefined,
      mockCtx,
    );

    assert.equal(res5.isError, false, `Disabled normalization edit should succeed: ${res5.content?.[0]?.text}`);
    const content5 = fs.readFileSync(testFile, "utf8");
    assert.ok(content5.includes("literal_\uff0e_here"), "U+FF0E should be preserved when toggle is false");

    // 6. When normalize_fullwidth_dots = false, search matches literal U+FF0E on disk
    await readToolDef.execute("r6", { path: testFileRel }, undefined, undefined, mockCtx);

    const res6 = await editToolDef.execute(
      "e6",
      {
        path: testFileRel,
        search: "literal_\uff0e_here",
        replace: "literal_\uff0e_matched_and_kept",
      },
      undefined,
      undefined,
      mockCtx,
    );

    assert.equal(res6.isError, false, `Literal U+FF0E search should succeed when toggle is false: ${res6.content?.[0]?.text}`);
    const content6 = fs.readFileSync(testFile, "utf8");
    assert.ok(content6.includes("literal_\uff0e_matched_and_kept"), "Literal U+FF0E should match and be kept");

    // 7. Verify narrowness: Japanese full stop '。' (U+3002) and literal escape '\\uff0e' are NOT touched
    configOverride = { editing: { normalize_fullwidth_dots: true } };
    await readToolDef.execute("r7", { path: testFileRel }, undefined, undefined, mockCtx);

    const res7 = await editToolDef.execute(
      "e7",
      {
        path: testFileRel,
        search: "print(\"hello\")",
        replace: "print(\"hello。\\uff0e\")",
      },
      undefined,
      undefined,
      mockCtx,
    );

    assert.equal(res7.isError, false, `Narrowness edit should succeed: ${res7.content?.[0]?.text}`);
    const content7 = fs.readFileSync(testFile, "utf8");
    assert.ok(content7.includes("hello。\\uff0e"), "Japanese '。' and literal '\\uff0e' must never be altered");

    console.log("✓ All Fullwidth Dot Normalization tests passed cleanly.");
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Cleanup error:", e);
    }
  }
}
