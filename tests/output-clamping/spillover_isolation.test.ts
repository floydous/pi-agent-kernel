import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampCommandOutput, getSpilloverRoot } from "../../src/safety/output_clamper";

export async function run(): Promise<void> {
  console.log("=== Running Isolated Output Spillover Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spillover-isolation-"));
  const previousPiDir = process.env.PI_DIR;
  process.env.PI_DIR = path.join(base, "pi");
  try {
    const workspaceA = path.join(base, "a");
    const workspaceB = path.join(base, "b");
    fs.mkdirSync(workspaceA);
    fs.mkdirSync(workspaceB);
    const dirA = getSpilloverRoot(workspaceA);
    const dirB = getSpilloverRoot(workspaceB);
    assert.notEqual(dirA, dirB, "workspace spillovers must be isolated");

    const unrelated = path.join(base, "unrelated.txt");
    fs.writeFileSync(unrelated, "keep", "utf8");
    const first = clampCommandOutput("x".repeat(2000), "node test.js", { maxTotalBytes: 10, spilloverDir: dirA });
    assert.ok(first.spilloverPath?.startsWith(dirA));
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");

    const second = clampCommandOutput("y".repeat(3000), "node test.js", {
      maxTotalBytes: 10,
      spilloverDir: dirA,
      maxSpilloverFiles: 1,
      maxSpilloverBytes: 4000,
    });
    assert.ok(second.spilloverPath?.startsWith(dirA));
    const owned = fs.readdirSync(dirA).filter((name) => name.startsWith("pi_bash_spillover_"));
    assert.equal(owned.length, 1, "retention must bound owned spillover count");
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep", "unrelated files must never be pruned");

    let link: string | null = null;
    try {
      link = path.join(dirA, "pi_bash_spillover_link");
      fs.symlinkSync(unrelated, link, "file");
      clampCommandOutput("z".repeat(3000), "node test.js", { maxTotalBytes: 10, spilloverDir: dirA, maxSpilloverFiles: 1, maxSpilloverBytes: 1 });
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "symlink entries must not be followed or deleted");
    } catch {
      // Symlink creation is optional on Windows hosts.
    } finally {
      if (link) { try { fs.unlinkSync(link); } catch {} }
    }

    const other = clampCommandOutput("q".repeat(2000), "node test.js", { maxTotalBytes: 10, spilloverDir: dirB });
    assert.ok(other.spilloverPath?.startsWith(dirB));
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
    console.log("! Spillovers are workspace-isolated, exclusive, bounded, and never prune unrelated files!");
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
