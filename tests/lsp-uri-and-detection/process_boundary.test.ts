import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StdioLspClient, buildLspEnvironment } from "../../src/lsp/lsp_client";

const FAKE_SERVER = String.raw`
const fs = require("fs");
const marker = process.argv[2];
const receivedArg = process.argv[3];
fs.writeFileSync(marker, JSON.stringify({
  hasSecret: process.env.PI_LSP_TEST_SECRET || null,
  hasApiKey: process.env.OPENAI_API_KEY || null,
  hasPath: process.env.PATH || process.env.Path || null,
  receivedArg,
}));
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\r\n\r\n" + body);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) break;
    const header = buffer.subarray(0, end).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) throw new Error("missing length");
    const length = Number(match[1]);
    const total = end + 4 + length;
    if (buffer.length < total) break;
    const message = JSON.parse(buffer.subarray(end + 4, total).toString("utf8"));
    buffer = buffer.subarray(total);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    } else if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    } else if (message.method === "exit") {
      process.exit(0);
    }
  }
});
`;

export async function run(): Promise<void> {
  console.log("=== Running LSP Process Boundary Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lsp process & boundary-"));
  const secretNames = ["PI_LSP_TEST_SECRET", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"];
  const previous = Object.fromEntries(secretNames.map((name) => [name, process.env[name]]));
  for (const name of secretNames) process.env[name] = `sentinel-${name}`;

  try {
    const env = buildLspEnvironment({ PI_LSP_TEST_SECRET: "override-secret" });
    assert.ok(env.PATH || env.Path, "PATH must survive the allowlist");
    for (const name of secretNames) {
      assert.equal(env[name], undefined, `${name} must not reach an LSP child`);
    }

    const script = path.join(base, "fake-lsp.js");
    const marker = path.join(base, "child-env.json");
    fs.writeFileSync(script, FAKE_SERVER, "utf8");
    const client = new StdioLspClient("boundary", {
      command: process.execPath,
      args: [script, marker, "a&echo INJECTED"],
      cwd: base,
      languageId: "typescript",
    });
    assert.equal(await client.start(), true, "shell-free process must complete initialize");
    const child = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(child.hasSecret, null);
    assert.equal(child.hasApiKey, null);
    assert.ok(child.hasPath);
    assert.equal(child.receivedArg, "a&echo INJECTED", "argument metacharacters must remain literal");
    await client.stop();

    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "lsp", "lsp_client.ts"),
      "utf8",
    );
    assert.match(source, /shell:\s*false/);
    assert.doesNotMatch(source, /shell:\s*process\.platform/);
    assert.doesNotMatch(source, /env:\s*\{\s*\.\.\.process\.env/);

    console.log("✓ LSP launch is shell-free and child environment excludes provider secrets!");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
