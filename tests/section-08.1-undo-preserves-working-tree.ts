// Section 8.1: Undo preserves working tree (--mixed vs --hard)
// Tests that undoLastCommit uses --mixed, not --hard, and that
// dirtyWorkingTree in the result correctly snapshots pre-undo state.

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { autoCommitFile, undoLastCommit } from "../src/editing/git-verify";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("8.1. Undo Preserves Working Tree (--mixed not --hard)", () => {
		// Test 1: Undo of a commit preserves the working tree (the key fix).
		// Setup: git init, write a file, commit it. Then modify the file
		// to simulate a follow-up edit, and commit that. Then create a
		// "user scratch" file (uncommitted). Then undo.
		// Expected: the file's content from the second commit ends up as
		// uncommitted modifications (preserved), and the user scratch
		// file is still there.
		{
			const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "undo-mixed-"));
			execSync("git init -b main", { cwd: tmpDir });
			execSync('git -c user.name="Test" -c user.email="[email protected]" commit --allow-empty -m "init"', { cwd: tmpDir });

			const target = path.join(tmpDir, "calculator.py");
			fs.writeFileSync(target, "v1 = 1\n", "utf8");
			autoCommitFile(tmpDir, target, "v1 commit");

			fs.writeFileSync(target, "v2 = 2\n", "utf8");
			autoCommitFile(tmpDir, target, "v2 commit");

			// User has uncommitted scratch
			const scratch = path.join(tmpDir, "scratch.py");
			fs.writeFileSync(scratch, "// user's scratch\n", "utf8");

			// Undo
			const result = undoLastCommit(tmpDir);
			assertPass("undoLastCommit succeeds after a valid commit", result.success, { result });
			assertPass(
				"undoLastCommit message describes HEAD~1 rollback",
				result.message.toLowerCase().includes("rolled back"),
				{ message: result.message }
			);

			// Key assertions for the fix:
			assertPass(
				"Working tree PRESERVED: v2 content is still on disk after undo (would be lost with --hard)",
				fs.readFileSync(target, "utf8") === "v2 = 2\n",
				{ actual: fs.readFileSync(target, "utf8") }
			);
			assertPass(
				"User scratch file PRESERVED: scratch.py still exists after undo",
				fs.existsSync(scratch)
			);
			assertPass(
				"dirtyWorkingTree contains the user's scratch file",
				result.dirtyWorkingTree.some((line) => line.includes("scratch.py")),
				{ dirtyWorkingTree: result.dirtyWorkingTree }
			);

			// Verify HEAD is back at the v1 commit, not the v2 commit
			const log = execSync("git log --oneline", { cwd: tmpDir }).toString();
			assertPass(
				"git log shows HEAD is at v1, not v2 (commit was undone)",
				log.includes("v1 commit") && !log.includes("v2 commit"),
				{ log }
			);

			fs.rmSync(tmpDir, { recursive: true, force: true });
			logPass("Undo uses --mixed: working tree and HEAD both correct");
		}

		// Test 2: Undo with a clean working tree returns empty dirtyWorkingTree
		{
			const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "undo-clean-"));
			execSync("git init -b main", { cwd: tmpDir });
			execSync('git -c user.name="Test" -c user.email="[email protected]" commit --allow-empty -m "init"', { cwd: tmpDir });

			const target = path.join(tmpDir, "file.txt");
			fs.writeFileSync(target, "hello\n", "utf8");
			autoCommitFile(tmpDir, target, "add file");

			const result = undoLastCommit(tmpDir);
			assertPass("undoLastCommit succeeds on a clean tree", result.success, { result });
			assertPass(
				"dirtyWorkingTree is empty when the working tree was clean before undo",
				result.dirtyWorkingTree.length === 0,
				{ dirtyWorkingTree: result.dirtyWorkingTree }
			);
			assertPass(
				"File still on disk after undo (clean tree case)",
				fs.readFileSync(target, "utf8") === "hello\n"
			);

			fs.rmSync(tmpDir, { recursive: true, force: true });
			logPass("Undo on a clean working tree: correct empty dirtyWorkingTree");
		}

		// Test 3: Undo when there's nothing to undo (only one commit exists)
		{
			const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "undo-only-init-"));
			execSync("git init -b main", { cwd: tmpDir });
			execSync('git -c user.name="Test" -c user.email="[email protected]" commit --allow-empty -m "init"', { cwd: tmpDir });

			// No commits beyond init. HEAD~1 doesn't exist.
			const result = undoLastCommit(tmpDir);
			assertPass(
				"undoLastCommit fails gracefully when there's no commit to undo",
				!result.success,
				{ result }
			);
			assertPass(
				"Failure message describes the rollback failure",
				result.message.toLowerCase().includes("rollback failed") ||
					result.message.toLowerCase().includes("failed"),
				{ message: result.message }
			);

			fs.rmSync(tmpDir, { recursive: true, force: true });
			logPass("Undo with no commit to undo: graceful failure");
		}

		// Test 4: Undo on a non-git directory
		{
			const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "not-a-repo-"));
			// Note: NO git init here.
			const result = undoLastCommit(tmpDir);
			assertPass(
				"undoLastCommit on a non-git dir returns success: false",
				!result.success,
				{ result }
			);
			assertPass(
				"Non-git-dir message is 'Not inside a git repository.'",
				result.message.includes("Not inside a git repository"),
				{ message: result.message }
			);
			assertPass(
				"dirtyWorkingTree is empty for a non-git dir",
				result.dirtyWorkingTree.length === 0,
				{ dirtyWorkingTree: result.dirtyWorkingTree }
			);

			fs.rmSync(tmpDir, { recursive: true, force: true });
			logPass("Undo on a non-git directory: clean failure");
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
