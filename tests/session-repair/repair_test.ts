import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeSessionFiles } from "../../src/context/session_repair";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testSessionRepair(): void {
  const ws = createTestWorkspace("session_repair_");
  try {
    const testAgentDir = path.join(ws.tempDir, "mock_agent");
    const testSessionDir = path.join(testAgentDir, "sessions", "--test-project--");
    fs.mkdirSync(testSessionDir, { recursive: true });
    const sessionFile = path.join(testSessionDir, "test_session.jsonl");
    const corruptEntries = [
      JSON.stringify({ type: "session", version: 3, id: "test-id", timestamp: "2026-08-23T00:00:00.000Z", cwd: ws.tempDir }),
      JSON.stringify({ type: "compaction", id: "compaction-1", timestamp: "2026-08-23T00:01:00.000Z", summary: "Summary without cost", usage: { input: 1000, output: 200, totalTokens: 1200 } }),
      JSON.stringify({ type: "message", id: "msg-1", timestamp: "2026-08-23T00:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { input: 500, output: 50, totalTokens: 550 } } }),
    ];
    const original = corruptEntries.join("\n") + "\n";
    fs.writeFileSync(sessionFile, original, "utf8");

    const preview = sanitizeSessionFiles({ agentDir: testAgentDir, apply: false });
    assertPass("Preview reports one candidate without writing", preview.candidateFiles === 1 && preview.repairedFiles === 0 && preview.dryRun, { preview });
    assertPass("Preview leaves session bytes unchanged", fs.readFileSync(sessionFile, "utf8") === original);

    const skipped = sanitizeSessionFiles({ agentDir: testAgentDir, skipFile: sessionFile, apply: true });
    assertPass("Active session path is skipped", skipped.skippedFiles === 1 && skipped.repairedFiles === 0, { skipped });
    assertPass("Skipped active session remains unchanged", fs.readFileSync(sessionFile, "utf8") === original);

    const repairedStats = sanitizeSessionFiles({ agentDir: testAgentDir, apply: true });
    assertPass("Explicit apply repairs one file and two entries", repairedStats.repairedFiles === 1 && repairedStats.repairedEntries === 2, { repairedStats });
    const repairedLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assertPass("Compaction cost is healed", repairedLines.find((entry) => entry.type === "compaction")?.usage?.cost?.total === 0);
    assertPass("Message cost is healed", repairedLines.find((entry) => entry.type === "message")?.message?.usage?.cost?.total === 0);
    assertPass("Original compaction input is preserved", repairedLines.find((entry) => entry.type === "compaction")?.usage?.input === 1000);
    const backups = fs.readdirSync(testSessionDir).filter((file) => file.endsWith(".agent-kernel.bak"));
    assertPass("A byte-preserving backup is created", backups.length === 1 && fs.readFileSync(path.join(testSessionDir, backups[0]!), "utf8") === original, { backups });
    assertPass("Repair lock is removed", !fs.existsSync(`${sessionFile}.agent-kernel-repair.lock`));

    const idempotent = sanitizeSessionFiles({ agentDir: testAgentDir, apply: true });
    assertPass("Second apply is idempotent", idempotent.candidateFiles === 0 && idempotent.repairedFiles === 0, { idempotent });

    const secondFile = path.join(testSessionDir, "locked.jsonl");
    fs.writeFileSync(secondFile, original, "utf8");
    fs.writeFileSync(`${secondFile}.agent-kernel-repair.lock`, "held", "utf8");
    const locked = sanitizeSessionFiles({ agentDir: testAgentDir, apply: true });
    assertPass("Existing lock prevents concurrent write", locked.failedFiles === 1, { locked });
    assertPass("Locked file remains unchanged", fs.readFileSync(secondFile, "utf8") === original);

    logPass("Session preview, skip, locked backup, CAS, and idempotency verified!");
  } finally {
    ws.cleanup();
  }
}
