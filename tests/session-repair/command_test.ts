import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import kernelExtension from "../../src/index";

export async function run(): Promise<void> {
  console.log("=== Running Explicit Session Repair Command Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "repair-command-"));
  const previousPiDir = process.env.PI_DIR;
  process.env.PI_DIR = path.join(base, "pi");
  try {
    const sessionDir = path.join(process.env.PI_DIR, "agent", "sessions", "project");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "active.jsonl");
    const original = [
      JSON.stringify({ type: "compaction", usage: { input: 1, output: 2 } }),
      "",
    ].join("\n");
    fs.writeFileSync(sessionFile, original, "utf8");

    const commands = new Map<string, any>();
    const pi: any = {
      registerTool() {},
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on() { return () => {}; },
    };
    await kernelExtension(pi);
    assert.equal(fs.readFileSync(sessionFile, "utf8"), original, "factory load must not repair sessions");
    const command = commands.get("repair-sessions");
    assert.ok(command, "explicit repair command must be registered");
    assert.deepEqual(command.getArgumentCompletions("--").map((option: any) => option.value), ["--apply"]);

    const ctx: any = {
      cwd: base,
      hasUI: false,
      ui: { notify() {} },
      sessionManager: { getSessionFile: () => undefined },
    };
    await command.handler("", ctx);
    assert.equal(fs.readFileSync(sessionFile, "utf8"), original, "preview command must not write");
    await command.handler("--apply", ctx);
    assert.notEqual(fs.readFileSync(sessionFile, "utf8"), original, "explicit apply repairs the session");
    assert.match(fs.readFileSync(sessionFile, "utf8"), /"total":0/);

    console.log("! Factory is read-only; preview is read-only; --apply performs the repair!");
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
