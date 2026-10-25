import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EpistemicGuard,
	getInspectionStateFilePath,
	loadSessionInspectionState,
	saveSessionInspectionState,
} from "../../src/safety/epistemic_guard";
import { assertPass, logPass } from "../_setup";

export function testSessionContinuity(): void {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-continuity-test-"));
	const testFile = path.join(tempDir, "config.ts");
	const sessionId = "continuity-session-abc";

	const originalContent = "export const API_HOST = 'https://api.example.com';\nexport const TIMEOUT = 3000;\n";
	fs.writeFileSync(testFile, originalContent, "utf8");

	try {
		const guard1 = new EpistemicGuard();

		// Record a read in guard1
		guard1.recordFileRead(testFile, sessionId, tempDir, originalContent, {
			coverage: { complete: true, ranges: [{ startLine: 1, endLine: 2 }] },
			provenance: "read",
		});

		// Verify state file was created on disk
		const stateFile = getInspectionStateFilePath(sessionId, tempDir);
		assertPass("inspection-state.json exists on disk", fs.existsSync(stateFile));

		// Verify contents of inspection-state.json
		const loadedDirect = loadSessionInspectionState(sessionId, tempDir);
		assertPass("loadSessionInspectionState loads persisted records", loadedDirect.size > 0);
		logPass("Session inspection state persistence");

		// Test 1: Restart simulation with untouched file
		// Create a completely new EpistemicGuard instance (simulating process restart)
		const guard2 = new EpistemicGuard();
		const restartCheck = guard2.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 1, endLine: 1 }],
			["export const API_HOST = 'https://api.example.com';"],
		);
		assertPass("Untouched file retains authorization across restart", restartCheck.allowed === true);
		logPass("Session restart continuity for untouched file");

		// Test 2: External file drift invalidation
		// Modify file externally on disk
		const modifiedContent = "export const API_HOST = 'https://api.v2.example.com';\nexport const TIMEOUT = 5000;\n";
		fs.writeFileSync(testFile, modifiedContent, "utf8");

		// Create a fresh guard (simulating resume after external modification)
		const guard3 = new EpistemicGuard();
		const driftedCheck = guard3.checkReadPrecondition(
			testFile,
			"edit",
			sessionId,
			tempDir,
			true,
			[{ startLine: 1, endLine: 1 }],
			["export const API_HOST = 'https://api.v2.example.com';"],
		);
		assertPass("Drifted file fails closed after external modification", driftedCheck.allowed === false);
		assertPass("Reason indicates uninspected/stale status", Boolean(driftedCheck.reason?.includes("BLOCKED: Uninspected File")));
		logPass("External file drift invalidation on session rehydration");

		// Test 3: Session isolation
		// Restore original content
		fs.writeFileSync(testFile, originalContent, "utf8");
		const guard4 = new EpistemicGuard();
		const differentSessionCheck = guard4.checkReadPrecondition(
			testFile,
			"edit",
			"different-session-xyz",
			tempDir,
			true,
			[{ startLine: 1, endLine: 1 }],
			["export const API_HOST = 'https://api.example.com';"],
		);
		assertPass("Different session ID does not inherit authorization", differentSessionCheck.allowed === false);
		logPass("Session isolation verification");

		// Test 4: purgeSession removes persisted state file
		const guard5 = new EpistemicGuard();
		// Re-record to ensure file exists
		guard5.recordFileRead(testFile, "purge-test-session", tempDir, originalContent, {
			coverage: { complete: true, ranges: [{ startLine: 1, endLine: 2 }] },
		});
		const purgeStateFile = getInspectionStateFilePath("purge-test-session", tempDir);
		assertPass("Purge test state file exists before purge", fs.existsSync(purgeStateFile));

		guard5.purgeSession("purge-test-session", tempDir);
		assertPass("purgeSession deletes inspection-state.json", !fs.existsSync(purgeStateFile));
		logPass("purgeSession disk cleanup");

		// Test 5: Corrupted / invalid JSON fails closed without crashing
		const corruptSession = "corrupt-json-session";
		const corruptPath = getInspectionStateFilePath(corruptSession, tempDir);
		fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
		fs.writeFileSync(corruptPath, "{ invalid json content ...", "utf8");
		const corruptLoaded = loadSessionInspectionState(corruptSession, tempDir);
		assertPass("Corrupt JSON fails closed with empty evidence map", corruptLoaded.size === 0);
		logPass("Corrupt JSON fail-closed protection");

		// Test 6: Unknown schema version fails closed
		const badVersionPath = getInspectionStateFilePath("bad-version-session", tempDir);
		fs.mkdirSync(path.dirname(badVersionPath), { recursive: true });
		fs.writeFileSync(badVersionPath, JSON.stringify({ version: 999, records: {} }), "utf8");
		const badVersionLoaded = loadSessionInspectionState("bad-version-session", tempDir);
		assertPass("Unknown schema version fails closed with empty evidence map", badVersionLoaded.size === 0);
		logPass("Schema version guardrail");

		// Test 7: Path traversal attempt in records payload is discarded
		const traversalSession = "traversal-session";
		const safeFile = path.join(tempDir, "safe.ts");
		fs.writeFileSync(safeFile, "export const safe = 1;\n", "utf8");
		const safeFingerprint = crypto.createHash("sha256").update("export const safe = 1;\n").digest("hex");

		const traversalPath = getInspectionStateFilePath(traversalSession, tempDir);
		fs.mkdirSync(path.dirname(traversalPath), { recursive: true });
		fs.writeFileSync(
			traversalPath,
			JSON.stringify({
				version: 1,
				workspace: tempDir,
				records: {
					"../../escaped.ts": {
						kind: "read",
						fingerprint: "fakehash",
						coverage: { complete: true, ranges: [] },
					},
					"safe.ts": {
						kind: "read",
						fingerprint: safeFingerprint,
						coverage: { complete: true, ranges: [{ startLine: 1, endLine: 1 }] },
					},
				},
			}),
			"utf8",
		);
		const traversalLoaded = loadSessionInspectionState(traversalSession, tempDir);
		assertPass("Path traversal record is discarded while safe record is retained", traversalLoaded.size === 1);
		const expectedSafeKey = process.platform === "win32" ? safeFile.toLowerCase() : safeFile;
		assertPass("safe.ts is present in restored evidence map", traversalLoaded.has(expectedSafeKey));
		logPass("Path traversal immunity");

		// Test 8: Oversized state file (>2MB) fails closed
		const oversizedSession = "oversized-session";
		const oversizedPath = getInspectionStateFilePath(oversizedSession, tempDir);
		fs.mkdirSync(path.dirname(oversizedPath), { recursive: true });
		const bigPadding = "a".repeat(2.2 * 1024 * 1024);
		fs.writeFileSync(oversizedPath, JSON.stringify({ version: 1, padding: bigPadding, records: {} }), "utf8");
		const oversizedLoaded = loadSessionInspectionState(oversizedSession, tempDir);
		assertPass("Oversized state file (>2MB) is rejected fail-closed", oversizedLoaded.size === 0);
		logPass("Oversized state file protection");

		// Test 9: Symlink pointing outside workspace is rejected
		try {
			const outsideFile = path.join(os.tmpdir(), `outside-target-${Date.now()}.ts`);
			fs.writeFileSync(outsideFile, "export const outside = 1;\n", "utf8");
			const outsideFingerprint = crypto.createHash("sha256").update("export const outside = 1;\n").digest("hex");
			const symlinkPath = path.join(tempDir, "symlink_escape.ts");
			fs.symlinkSync(outsideFile, symlinkPath, "file");

			const symlinkSession = "symlink-session";
			const symlinkStatePath = getInspectionStateFilePath(symlinkSession, tempDir);
			fs.mkdirSync(path.dirname(symlinkStatePath), { recursive: true });
			fs.writeFileSync(
				symlinkStatePath,
				JSON.stringify({
					version: 1,
					workspace: tempDir,
					records: {
						"symlink_escape.ts": {
							kind: "read",
							fingerprint: outsideFingerprint,
							coverage: { complete: true, ranges: [] },
						},
					},
				}),
				"utf8",
			);
			const symlinkLoaded = loadSessionInspectionState(symlinkSession, tempDir);
			assertPass("Symlinks pointing outside workspace root are rejected", symlinkLoaded.size === 0);
			logPass("Symlink workspace escape containment");
			fs.unlinkSync(outsideFile);
		} catch (e) {
			// Windows non-admin may throw on symlink creation; skip gracefully if unprivileged
		}

		// Test 10: Malicious or invalid records validation
		const invalidSession = "invalid-records-session";
		const invalidStatePath = getInspectionStateFilePath(invalidSession, tempDir);
		fs.mkdirSync(path.dirname(invalidStatePath), { recursive: true });
		fs.writeFileSync(
			invalidStatePath,
			JSON.stringify({
				version: 1,
				workspace: tempDir,
				records: {
					"safe.ts": {
						kind: "unknown_kind", // invalid kind
						fingerprint: safeFingerprint,
					},
					"config.ts": {
						kind: "search",
						fingerprint: crypto.createHash("sha256").update(originalContent).digest("hex"),
						coverage: { complete: true, ranges: [] }, // search must never inherit complete coverage
					},
				},
			}),
			"utf8",
		);
		const invalidLoaded = loadSessionInspectionState(invalidSession, tempDir);
		assertPass("Record with invalid kind is rejected", !invalidLoaded.has(expectedSafeKey));
		const configKey = process.platform === "win32" ? testFile.toLowerCase() : testFile;
		const configEvidence = invalidLoaded.get(configKey);
		assertPass("Search kind cannot manufacture complete coverage", configEvidence?.coverage.complete === false);
		logPass("Untrusted inspection record runtime validation");

		// Test 11: Oversized record count (>1000 entries) fails closed
		const floodSession = "flood-records-session";
		const floodStatePath = getInspectionStateFilePath(floodSession, tempDir);
		fs.mkdirSync(path.dirname(floodStatePath), { recursive: true });
		const floodedRecords: Record<string, any> = {};
		for (let i = 0; i < 1005; i++) {
			floodedRecords[`f_${i}.ts`] = {
				kind: "read",
				fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				coverage: { complete: false, ranges: [] },
			};
		}
		fs.writeFileSync(
			floodStatePath,
			JSON.stringify({ version: 1, workspace: tempDir, records: floodedRecords }),
			"utf8",
		);
		const floodLoaded = loadSessionInspectionState(floodSession, tempDir);
		assertPass("Flooded record count (>1000) fails closed", floodLoaded.size === 0);
		logPass("Flooded record count boundary protection");

		console.log("✓ All Session Continuity tests passed successfully!\n");
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch (e) {
			void e;
		}
	}
}

if (process.argv[1]?.endsWith("session_continuity_test.ts")) {
	testSessionContinuity();
}
