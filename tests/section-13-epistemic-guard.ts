// Section 13: Read-Before-Write Epistemic Guard Engine
// Tests EpistemicGuard blocks ungrounded edits, allows new file writes, allows
// edits after reads/bash inspection, enforces per-session scope, and respects
// per-platform case-sensitivity.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	EpistemicGuard,
	extractInspectedFilesFromCommand,
} from "../src/safety/epistemic_guard";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("13. Read-Before-Write Epistemic Guard Engine", () => {
		const ws = createTestWorkspace();
		try {
			const guard = new EpistemicGuard();
			const TEST_SESSION = "__test_session__";

			// Existing file not yet read in session -> edit must be blocked
			const uninspectedCheck = guard.checkReadPrecondition(
				ws.calculatorPath,
				"edit",
				TEST_SESSION,
			);
			assertPass(
				"Epistemic guard blocks edit on unread existing file",
				!uninspectedCheck.allowed,
				{ uninspectedCheck },
			);
			assertPass(
				"Rejection reason includes epistemic warning",
				uninspectedCheck.reason?.includes("EPISTEMIC GUARD REJECTION") ?? false,
				{ reason: uninspectedCheck.reason },
			);

			// Brand-new file -> write must be allowed
			const nonExistingFilePath = path.join(ws.tempDir, "new_module.py");
			const newFileCheck = guard.checkReadPrecondition(
				nonExistingFilePath,
				"write",
				TEST_SESSION,
			);
			assertPass(
				"Epistemic guard allows write on brand-new file",
				newFileCheck.allowed,
				{ newFileCheck },
			);

			// Record file inspection via read
			guard.recordFileRead(ws.calculatorPath, TEST_SESSION);
			const inspectedCheck = guard.checkReadPrecondition(
				ws.calculatorPath,
				"edit",
				TEST_SESSION,
			);
			assertPass(
				"Epistemic guard allows edit after file was inspected",
				inspectedCheck.allowed,
				{ inspectedCheck },
			);

			// Test Bash Command Inspection Extraction
			const proxyServerPath = path.join(ws.tempDir, "proxy_server.py");
			fs.writeFileSync(proxyServerPath, "# mock\n", "utf8");

			const extracted1 = extractInspectedFilesFromCommand(
				`cat "proxy_server.py" | grep -n "def"`,
				ws.tempDir,
			);
			assertPass(
				"Extract file from piped bash command",
				extracted1.some((f) => f.includes("proxy_server.py")),
				{ extracted1 },
			);

			const extracted2 = extractInspectedFilesFromCommand(
				`head -n 50 calculator.py && grep "tax" proxy_server.py`,
				ws.tempDir,
			);
			assertPass(
				"Extract multiple files from compound bash command",
				extracted2.length >= 2,
				{ extracted2 },
			);

			const metadataCommands = ["ls", "stat", "wc -l"];
			for (const command of metadataCommands) {
				const extracted = extractInspectedFilesFromCommand(
					`${command} proxy_server.py`,
					ws.tempDir,
				);
				assertPass(
					`Metadata-only command is not inspection evidence: ${command}`,
					extracted.length === 0,
					{ command, extracted },
				);
			}

			// A search command that produces no matching content must not satisfy
			// the read-before-write guard merely because its path was referenced.
			guard.resetSession(TEST_SESSION);
			guard.recordCommandExecution(
				`grep -c absent proxy_server.py`,
				ws.tempDir,
				TEST_SESSION,
			);
			const zeroOutputSearchCheck = guard.checkReadPrecondition(
				proxyServerPath,
				"edit",
				TEST_SESSION,
			);
			assertPass(
				"Zero-output search does not satisfy inspection evidence",
				!zeroOutputSearchCheck.allowed,
				{ zeroOutputSearchCheck },
			);

			// Verify EpistemicGuard allows edit after bash inspection
			guard.resetSession(TEST_SESSION);
			guard.resetSession(TEST_SESSION);
			const preBashCheck = guard.checkReadPrecondition(
				proxyServerPath,
				"edit",
				TEST_SESSION,
			);
			assertPass(
				"Guard blocks edit before bash inspection",
				!preBashCheck.allowed,
				{ preBashCheck },
			);

			guard.recordCommandExecution(
				`cat proxy_server.py`,
				ws.tempDir,
				TEST_SESSION,
			);
			const postBashCheck = guard.checkReadPrecondition(
				proxyServerPath,
				"edit",
				TEST_SESSION,
			);
			assertPass(
				"Guard allows edit after bash inspection",
				postBashCheck.allowed,
				{ postBashCheck },
			);

			// Per-session isolation
			guard.recordFileRead(ws.calculatorPath, "session_A");
			const otherSessionCheck = guard.checkReadPrecondition(
				ws.calculatorPath,
				"edit",
				"session_B",
			);
			assertPass(
				"Per-session scope leak prevented (session_B can't see session_A's reads)",
				!otherSessionCheck.allowed,
				{ otherSessionCheck },
			);
			guard.resetSession("session_A");

			// Case-sensitivity regression: on Windows Auth.ts and auth.ts must match,
			// on Linux/macOS they must NOT match (case-sensitive filesystem).
			const caseTestDir = path.join(ws.tempDir, "case-test");
			fs.mkdirSync(caseTestDir, { recursive: true });
			const mixedCaseFile = path.join(caseTestDir, "Auth.ts");
			const lowerCaseFile = path.join(caseTestDir, "auth.ts");
			fs.writeFileSync(mixedCaseFile, "// mixed\n", "utf8");
			fs.writeFileSync(lowerCaseFile, "// lower\n", "utf8");
			const caseGuard = new EpistemicGuard();
			caseGuard.recordFileRead(mixedCaseFile, "case_session");
			const crossCaseCheck = caseGuard.checkReadPrecondition(
				lowerCaseFile,
				"edit",
				"case_session",
			);
			if (process.platform === "win32") {
				assertPass(
					"On Windows, Auth.ts read allows editing auth.ts (case-insensitive FS)",
					crossCaseCheck.allowed,
					{ crossCaseCheck },
				);
			} else {
				assertPass(
					"On Linux/macOS, Auth.ts read does NOT allow editing auth.ts (case-sensitive FS)",
					!crossCaseCheck.allowed,
					{ crossCaseCheck },
				);
			}

			logPass(
				"Read-Before-Write epistemic guard & bash terminal inspection verified!",
			);
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
