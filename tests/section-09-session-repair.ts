// Section 9: Session File Repair & Self-Healing
// Tests sanitizeSessionFiles repairs missing usage.cost.total fields.

import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeSessionFiles } from "../context/session_repair";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("9. Session File Repair & Self-Healing", () => {
		const ws = createTestWorkspace();
		try {
			// Create a mock agent directory with corrupt session files
			const testAgentDir = path.join(ws.tempDir, "mock_agent");
			const testSessionDir = path.join(testAgentDir, "sessions", "--test-project--");
			fs.mkdirSync(testSessionDir, { recursive: true });

			// Create a mock corrupt session file missing usage.cost.total
			const corruptJsonlPath = path.join(testSessionDir, "test_session.jsonl");
			const corruptEntries = [
				JSON.stringify({ type: "session", version: 3, id: "test-id", timestamp: "2026-08-23T00:00:00.000Z", cwd: ws.tempDir }),
				JSON.stringify({
					type: "compaction",
					id: "compaction-1",
					timestamp: "2026-08-23T00:01:00.000Z",
					summary: "Summary without cost",
					usage: { input: 1000, output: 200, totalTokens: 1200 }, // MISSING cost.total!
				}),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					timestamp: "2026-08-23T00:02:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Hello" }],
						usage: { input: 500, output: 50, totalTokens: 550 }, // MISSING cost.total!
					},
				}),
			];
			fs.writeFileSync(corruptJsonlPath, corruptEntries.join("\n") + "\n", "utf8");

			const repairStats = sanitizeSessionFiles(testAgentDir);
			console.log("Repair stats:", repairStats);

			const repairedContent = fs.readFileSync(corruptJsonlPath, "utf8");
			const repairedLines = repairedContent.trim().split("\n").map((l) => JSON.parse(l));

			const compactionEntry = repairedLines.find((e) => e.type === "compaction");
			const messageEntry = repairedLines.find((e) => e.type === "message");

			assertPass(
				"Session repair sanitizer verified (all cost.total fields healed)",
				repairStats.repairedFiles === 1 &&
					repairStats.repairedEntries === 2 &&
					compactionEntry?.usage?.cost?.total === 0 &&
					messageEntry?.message?.usage?.cost?.total === 0,
				{ repairStats, repairedLines }
			);
			logPass("Session repair sanitizer verified (all cost.total fields healed)!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
