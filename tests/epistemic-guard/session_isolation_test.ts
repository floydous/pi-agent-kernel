import * as fs from "node:fs";
import * as path from "node:path";
import { EpistemicGuard, extractInspectedFilesFromCommand } from "../../src/safety/epistemic_guard";
import { assertPass, createTestWorkspace, logPass } from "../_setup";

export function testSessionIsolation(): void {
	const ws = createTestWorkspace("epistemic_session_");
	try {
		const testFile = path.join(ws.tempDir, "foo.ts");
		fs.writeFileSync(testFile, "// hello\n", "utf8");

		const guard = new EpistemicGuard();
		guard.recordFileRead(testFile, "session_A");
		const checkA = guard.checkReadPrecondition(testFile, "edit", "session_A");
		const checkB = guard.checkReadPrecondition(testFile, "edit", "session_B");
		assertPass("Session A sees its inspected file", checkA.allowed, { checkA });
		assertPass("Session B cannot use Session A's inspection", !checkB.allowed, { checkB });

		const other = path.join(ws.tempDir, "bar.ts");
		fs.writeFileSync(other, "// bar\n", "utf8");
		guard.recordFileRead(other, "session_B");
		guard.resetSession("session_A");
		assertPass(
			"Resetting Session A clears only Session A",
			!guard.checkReadPrecondition(testFile, "edit", "session_A").allowed,
		);
		assertPass(
			"Resetting Session A preserves Session B",
			guard.checkReadPrecondition(other, "edit", "session_B").allowed,
		);

		const relativePath = path.relative(process.cwd(), testFile);
		guard.recordFileRead(testFile, "session_C");
		assertPass(
			"Relative and absolute paths normalize identically",
			guard.checkReadPrecondition(relativePath, "edit", "session_C").allowed,
		);

		const defaultSession = "__default__";
		guard.recordFileRead(testFile, defaultSession);
		assertPass(
			"The default session identifier works normally",
			guard.checkReadPrecondition(testFile, "edit", defaultSession).allowed,
		);

		const realFile = path.join(ws.tempDir, "real.py");
		fs.writeFileSync(realFile, "x = 1\n", "utf8");
		const extracted = extractInspectedFilesFromCommand(`cat "${path.basename(realFile)}"`, ws.tempDir);
		assertPass(
			"Shell inspection parsing finds the inspected file",
			extracted.some((file) => file.endsWith("real.py")),
			{ extracted },
		);

		const brandNew = path.join(ws.tempDir, "brand-new.ts");
		assertPass(
			"Writing a brand-new file does not require a prior read",
			guard.checkReadPrecondition(brandNew, "write", "session_C").allowed,
		);

		logPass("Per-session epistemic guard isolation and path normalization verified!");
	} finally {
		ws.cleanup();
	}
}
