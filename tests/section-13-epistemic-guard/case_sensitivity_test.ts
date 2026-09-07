import * as fs from "node:fs";
import * as path from "node:path";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testCaseSensitivity(): void {
	const ws = createTestWorkspace("epistemic_case_");
	try {
		// Create file with one casing
		const authPath = path.join(ws.tempDir, "auth.ts");
		fs.writeFileSync(authPath, "export const x = 1;", "utf8");

		const guard = new EpistemicGuard();
		const SESSION = "case_session";
		guard.recordFileRead(authPath, SESSION);

		// Read auth.ts, then check edit on different casing
		const crossCaseCheck = guard.checkReadPrecondition(
			path.join(ws.tempDir, "Auth.ts"),
			"edit",
			SESSION,
			ws.tempDir,
		);
		if (process.platform === "win32") {
			assertPass("On Windows, Auth.ts read allows editing auth.ts (case-insensitive FS)", crossCaseCheck.allowed === true, { crossCaseCheck });
		} else {
			assertPass("On Linux/macOS, Auth.ts read does NOT allow editing auth.ts (case-sensitive FS)", crossCaseCheck.allowed === false, { crossCaseCheck });
		}

		logPass("Per-platform case-sensitivity for epistemic guard verified!");
	} finally {
		ws.cleanup();
	}
}
