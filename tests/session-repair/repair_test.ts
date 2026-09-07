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

		const corruptJsonlPath = path.join(testSessionDir, "test_session.jsonl");
		const corruptEntries = [
			JSON.stringify({ type: "session", version: 3, id: "test-id", timestamp: "2026-08-23T00:00:00.000Z", cwd: ws.tempDir }),
			JSON.stringify({
				type: "compaction",
				id: "compaction-1",
				timestamp: "2026-08-23T00:01:00.000Z",
				summary: "Summary without cost",
				usage: { input: 1000, output: 200, totalTokens: 1200 },
			}),
			JSON.stringify({
				type: "message",
				id: "msg-1",
				timestamp: "2026-08-23T00:02:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
					usage: { input: 500, output: 50, totalTokens: 550 },
				},
			}),
		];
		fs.writeFileSync(corruptJsonlPath, corruptEntries.join("\n") + "\n", "utf8");

		const repairStats = sanitizeSessionFiles(testAgentDir);
		assertPass("Repair stats indicate exactly 1 file repaired", repairStats.repairedFiles === 1, { repairStats });
		assertPass("Repair stats indicate exactly 2 entries healed", repairStats.repairedEntries === 2, { repairStats });

		const repairedContent = fs.readFileSync(corruptJsonlPath, "utf8");
		const repairedLines = repairedContent.trim().split("\n").map((l) => JSON.parse(l));

		const compactionEntry = repairedLines.find((e) => e.type === "compaction");
		const messageEntry = repairedLines.find((e) => e.type === "message");

		assertPass(
			"Compaction entry has healed cost.total === 0",
			compactionEntry?.usage?.cost?.total === 0,
			{ compactionEntry }
		);
		assertPass(
			"Message entry has healed cost.total === 0",
			messageEntry?.message?.usage?.cost?.total === 0,
			{ messageEntry }
		);
		// Original input/output/totalTokens preserved
		assertPass(
			"Original usage.input preserved on compaction",
			compactionEntry?.usage?.input === 1000,
			{ compactionEntry }
		);

		logPass("Session repair sanitizer verified with strict assertions!");
	} finally {
		ws.cleanup();
	}
}
