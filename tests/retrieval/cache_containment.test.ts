import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HybridSearchIndex, getSearchCacheDir } from "../../src/retrieval/search_index";

function makeJunction(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

export async function run(): Promise<void> {
  console.log("=== Running Search Cache Containment Tests ===");
  const previousPiDir = process.env.PI_DIR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cache-containment-"));

  try {
    const workspace = path.join(base, "workspace");
    const piRoot = path.join(base, "pi");
    const outside = path.join(base, "outside-workspace");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    fs.mkdirSync(piRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const workspaceCacheLink = path.join(workspace, ".pi", "cache");
    const workspaceLinkCreated = makeJunction(outside, workspaceCacheLink);

    process.env.PI_DIR = piRoot;
    const index = new HybridSearchIndex(workspace, "lean");
    index.saveToDisk();
    const cacheDir = getSearchCacheDir(workspace);
    assert.equal(fs.existsSync(path.join(cacheDir, "index.json")), true);
    assert.equal(path.relative(workspace, cacheDir).startsWith(".."), true, "cache must live outside the workspace");
    assert.equal(path.relative(piRoot, cacheDir).startsWith(".."), false, "cache must remain under trusted PI_DIR");
    if (workspaceLinkCreated) {
      assert.deepEqual(fs.readdirSync(outside), [], "workspace junction must not redirect cache writes");
    }

    const secondPiRoot = path.join(base, "pi-malicious");
    const secondOutside = path.join(base, "outside-pi-root");
    fs.mkdirSync(path.join(secondPiRoot, "cache", "agent-kernel"), { recursive: true });
    fs.mkdirSync(secondOutside, { recursive: true });
    const trustedSearchLink = path.join(secondPiRoot, "cache", "agent-kernel", "search");
    const trustedLinkCreated = makeJunction(secondOutside, trustedSearchLink);
    process.env.PI_DIR = secondPiRoot;
    if (trustedLinkCreated) {
      assert.throws(
        () => getSearchCacheDir(workspace),
        /link|escapes trusted root/i,
        "a linked trusted cache root must fail closed",
      );
      assert.deepEqual(fs.readdirSync(secondOutside), [], "linked cache root must not receive writes");
    }

    console.log("✓ Workspace and trusted-cache junction redirects cannot receive index writes!");
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
