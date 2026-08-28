// Section 8: Git Auto-Commit & Undo
// Tests autoCommitFile writes a commit and undoLastCommit reverts it.

import { execSync } from "node:child_process";
import { autoCommitFile, undoLastCommit } from "../src/editing/git-verify";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("8. Git Auto-Commit & Undo", () => {
		const ws = createTestWorkspace();
		try {
			const committed = autoCommitFile(ws.tempDir, ws.calculatorPath, "pi: update calculator");
			console.log("Auto-committed:", committed);

			const logOutput = execSync("git log -n 1 --oneline", { cwd: ws.tempDir }).toString();
			console.log("Latest commit:", logOutput.trim());

			const undoResult = undoLastCommit(ws.tempDir);
			console.log("Undo result:", undoResult.message);
			const logAfterUndo = execSync("git log -n 1 --oneline", { cwd: ws.tempDir }).toString();
			console.log("Commit after undo:", logAfterUndo.trim());

			assertPass(
				"Git commit & undo test passed",
				committed && undoResult.success && logAfterUndo.includes("init"),
				{ committed, undoResult, logAfterUndo }
			);
			logPass("Git commit & undo test passed!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
