import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileSyncAtomic } from "../../src/safety/atomic_write";

export async function run(): Promise<void> {
  console.log("=== Running Atomic File Metadata Tests ===");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-metadata-"));
  try {
    const executable = path.join(dir, "script.sh");
    fs.writeFileSync(executable, "old", { encoding: "utf8", mode: 0o755 });
    writeFileSyncAtomic(executable, "new");
    assert.equal(fs.readFileSync(executable, "utf8"), "new");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(executable).mode & 0o777, 0o755, "executable mode must be preserved");
    }
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false, "temp file must be cleaned");

    const restricted = path.join(dir, "secret");
    fs.writeFileSync(restricted, "old", { encoding: "utf8", mode: 0o600 });
    writeFileSyncAtomic(restricted, "new");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(restricted).mode & 0o777, 0o600, "restrictive mode must be preserved");
    }

    const symlinkTarget = path.join(dir, "target.txt");
    const symlink = path.join(dir, "link.txt");
    fs.writeFileSync(symlinkTarget, "target", "utf8");
    let symlinkCreated = true;
    try {
      fs.symlinkSync(symlinkTarget, symlink, "file");
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      assert.throws(() => writeFileSyncAtomic(symlink, "replacement"), /symbolic link|symlink/i);
      assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "target", "symlink target must not be replaced");
    }

    console.log("! Atomic replacement preserves mode, cleans temps, and refuses symlink targets!");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
