import * as path from "node:path";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testGuardBasic(): void {
	const ws = createTestWorkspace("epistemic_basic_");
	try {
		const guard = new EpistemicGuard();
		const SESSION = "epistemic_basic_test";

		// Uninspected existing file -> edit blocked
		const blocked = guard.checkReadPrecondition(ws.calculatorPath, "edit", SESSION);
		assertPass("Edit on uninspected file is blocked", blocked.allowed === false, { blocked });

		// After read, edit must be allowed
		guard.recordFileRead(ws.calculatorPath, SESSION);
		const allowed = guard.checkReadPrecondition(ws.calculatorPath, "edit", SESSION);
		assertPass("Edit after read is allowed", allowed.allowed === true, { allowed });

		// Write to a new file is always allowed
		const newFilePath = path.join(ws.tempDir, "new_file.py");
		const writeAllowed = guard.checkReadPrecondition(newFilePath, "write", SESSION, ws.tempDir);
		assertPass("Write to new file is always allowed", writeAllowed.allowed === true, { writeAllowed });

		logPass("Epistemic guard read-before-write basics verified!");
	} finally {
		ws.cleanup();
	}
}
