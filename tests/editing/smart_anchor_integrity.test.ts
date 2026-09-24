import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySmartAnchorEdits,
  computeLineHash,
  preflightSmartAnchorEdits,
} from "../../src/editing/smart_anchor";

export async function run(): Promise<void> {
  console.log("=== Running Smart Anchor Integrity Tests ===");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-anchor-integrity-"));
  try {
    const file = path.join(dir, "sample.ts");
    const source = [
      "export function calculate() {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b;",
      "}",
    ].join("\n");
    fs.writeFileSync(file, source, "utf8");
    const lines = source.split("\n");
    const line3Hash = computeLineHash(lines, 2);
    const line4Hash = computeLineHash(lines, 3);

    const wrongStart = applySmartAnchorEdits(file, [
      { pos: `4#${line3Hash}`, lines: ["  return 99;"] },
    ]);
    assert.equal(wrongStart.success, false);
    assert.match(wrongStart.error || "", /E_STALE_ANCHOR/);
    assert.equal(fs.readFileSync(file, "utf8"), source, "stale start hash must leave disk unchanged");

    const wrongEnd = applySmartAnchorEdits(file, [
      { pos: `4#${line4Hash}`, end: `5#${line3Hash}`, lines: ["  return 99;"] },
    ]);
    assert.equal(wrongEnd.success, false);
    assert.equal(fs.readFileSync(file, "utf8"), source, "stale end hash must leave disk unchanged");

    const preflight = preflightSmartAnchorEdits(source, [
      { pos: `4#${line4Hash}`, lines: ["  return 99;"] },
    ]);
    assert.equal(preflight.success, true);
    assert.equal(preflight.resolvedSpans?.[0]?.recoveredNeighbor, false);

    const correct = applySmartAnchorEdits(file, [
      { pos: `4#${line4Hash}`, lines: ["  return 99;"] },
    ]);
    assert.equal(correct.success, true);
    assert.match(fs.readFileSync(file, "utf8"), /return 99;/);

    console.log("✓ Wrong-line neighbor hashes fail closed; exact anchors edit only their target!");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
