// Section 13: Read-Before-Write Epistemic Guard Engine
// Tests EpistemicGuard blocks ungrounded edits, allows new file writes, allows
// edits after reads/bash inspection, enforces per-session scope, and respects
// per-platform case-sensitivity.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EpistemicGuard,
	extractInspectedFilesFromCommand,
	resolveUserPath,
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
				uninspectedCheck.reason?.includes("BLOCKED: Read before edit") ?? false,
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

			// Pi accepts the OS temp directory as disposable scratch space for
			// measurements, while arbitrary external roots remain rejected.
			const tempScratchPath = path.join(os.tmpdir(), "pi_kernel_measurement.ts");
			const tempScratchCheck = guard.checkReadPrecondition(
				tempScratchPath,
				"write",
				TEST_SESSION,
				ws.tempDir,
			);
			assertPass(
				"Epistemic guard allows new writes in OS temp scratch space",
				tempScratchCheck.allowed,
				{ tempScratchCheck },
			);
			const externalPath = path.join(os.homedir(), "pi_kernel_external.ts");
			const externalCheck = guard.checkReadPrecondition(
				externalPath,
				"write",
				TEST_SESSION,
				ws.tempDir,
			);
			assertPass(
				"Epistemic guard still rejects arbitrary external roots",
				!externalCheck.allowed,
				{ externalCheck },
			);
			assertPass(
				"User-home shorthand resolves to the host home directory",
				path.normalize(resolveUserPath("~")) === path.normalize(os.homedir()),
				{ home: os.homedir() },
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

			const nonContentSearchCommands = [
				"grep -c absent proxy_server.py",
				"rg --count absent proxy_server.py",
				"grep -q absent proxy_server.py",
				"rg -l absent proxy_server.py",
			];
			for (const command of nonContentSearchCommands) {
				const extracted = extractInspectedFilesFromCommand(command, ws.tempDir);
				assertPass(
					`Non-content search mode is not inspection evidence: ${command}`,
					extracted.length === 0,
					{ command, extracted },
				);
			}

			// Command parsing cannot observe whether a search produced output because
			// this hook runs before the shell result exists. The guard therefore
			// records classified content-reader commands, not result-level claims.

			// Verify EpistemicGuard allows edit after bash inspection
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
				true,
				fs.readFileSync(proxyServerPath, "utf8"),
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
			const pipedGuard = new EpistemicGuard();
			pipedGuard.recordCommandExecution(
				`cat proxy_server.py | grep -n def`,
				ws.tempDir,
				TEST_SESSION,
				true,
				"1:# mock\n",
			);
			const pipedCheck = pipedGuard.checkReadPrecondition(
				proxyServerPath,
				"edit",
				TEST_SESSION,
			);
			assertPass(
				"Piped Bash output does not overclaim complete file visibility",
				!pipedCheck.allowed && pipedCheck.reason?.includes("Target lines not covered") === true,
				{ pipedCheck },
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

			// Coverage-aware evidence: a paginated read authorizes only the visible
			// source range, while a complete read authorizes any matched target.
			const coverageGuard = new EpistemicGuard();
			const coverageSession = "coverage_session";
			const coveragePath = path.join(ws.tempDir, "coverage.py");
			fs.writeFileSync(coveragePath, "line1\nline2\nline3\nline4\nline5\n", "utf8");
			coverageGuard.recordFileRead(coveragePath, coverageSession, ws.tempDir, undefined, {
				coverage: { complete: false, ranges: [{ startLine: 1, endLine: 3 }], totalLines: 5 },
				provenance: "read",
			});
			const visibleTarget = coverageGuard.checkReadPrecondition(
				coveragePath,
				"edit",
				coverageSession,
				ws.tempDir,
				true,
				[{ startLine: 2, endLine: 3 }],
			);
			const hiddenTarget = coverageGuard.checkReadPrecondition(
				coveragePath,
				"edit",
				coverageSession,
				ws.tempDir,
				true,
				[{ startLine: 4, endLine: 4 }],
			);
			assertPass("Coverage ledger allows edits inside visible range", visibleTarget.allowed, { visibleTarget });
			assertPass(
				"Coverage ledger blocks edits outside visible range",
				!hiddenTarget.allowed && hiddenTarget.reason?.includes("Target lines not covered") === true,
				{ hiddenTarget },
			);
			const coverageEvidence = coverageGuard.getEvidence(coveragePath, coverageSession, ws.tempDir);
			assertPass(
				"Coverage ledger exposes snapshot, provenance, and ranges",
				coverageEvidence?.provenance === "read" &&
					coverageEvidence.snapshot.length === 64 &&
					coverageEvidence.coverage.ranges[0]?.endLine === 3,
				{ coverageEvidence },
			);

			coverageGuard.recordFileRead(coveragePath, coverageSession, ws.tempDir, undefined, {
				coverage: { complete: false, ranges: [{ startLine: 5, endLine: 5 }], totalLines: 5 },
				provenance: "read",
			});
			const mergedEvidence = coverageGuard.getEvidence(coveragePath, coverageSession, ws.tempDir);
			assertPass(
				"Repeated partial reads merge visible ranges for one file",
				mergedEvidence?.coverage.ranges.length === 2 &&
					mergedEvidence.coverage.ranges[1]?.startLine === 5,
				{ mergedEvidence },
			);

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
