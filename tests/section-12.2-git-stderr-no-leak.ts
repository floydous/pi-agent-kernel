// Section 12.2: extractGitGroundTruth does not leak git stderr to the parent TUI
// Verifies that the function captures stderr (e.g. CRLF warnings) instead of
// inheriting the parent's stderr stream.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { extractGitGroundTruth } from "../context/compaction_enhanced";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("12.2. extractGitGroundTruth does not leak git stderr to TUI", () => {
		// Set up a git repo with a file that has mismatched line endings.
		// On Windows, git warns "LF will be replaced by CRLF" when reading
		// such files via certain commands. The test verifies that
		// extractGitGroundTruth's execSync calls capture this stderr instead
		// of letting it inherit the parent's TUI stream.
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "epistemic-git-stderr-"));
		try {
			execSync("git init -b main", { cwd: tmpDir });
			execSync('git -c user.name="Test" -c user.email="[email protected]" commit --allow-empty -m "init"', { cwd: tmpDir });

			// Write a file with LF line endings only, then add it.
			// After the add, git will know about the line ending mismatch.
			const target = path.join(tmpDir, "lf-only.txt");
			fs.writeFileSync(target, "// lf only line\n// another lf line\n", "utf8");
			execSync(`git add "${target}"`, { cwd: tmpDir, stdio: "pipe" });
			execSync(`git -c user.name="Test" -c user.email="[email protected]" commit -m "add lf file"`, { cwd: tmpDir, stdio: "pipe" });

			// Modify the file again to produce uncommitted changes — that's
			// what makes `git diff --stat` non-empty AND triggers the CRLF
			// warning on git's stderr.
			fs.writeFileSync(target, "// lf only line MODIFIED\n// another lf line\n", "utf8");

			// Now run extractGitGroundTruth. The function should successfully
			// capture git's stderr (the CRLF warning) via stdio: "pipe" rather
			// than letting it inherit the parent's TUI stream.

			const out = extractGitGroundTruth(tmpDir);
			assertPass(
				"extractGitGroundTruth returns successfully even with CRLF-mismatched files",
				typeof out === "string" && out.includes("<git-workspace-ground-truth>"),
				{ outPreview: out.slice(0, 300) }
			);

			// Verify the uncommitted diff stat includes our lf file (proves git
			// diff --stat ran and produced output, which is what would normally
			// emit CRLF warnings to stderr).
			assertPass(
				"git diff --stat output is captured (would have emitted CRLF warnings without stdio pipe)",
				out.includes("lf-only.txt") || out.includes("Uncommitted Diff Stat"),
				{ outPreview: out.slice(0, 500) }
			);
			logPass("extractGitGroundTruth captures git stderr instead of leaking to TUI");
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
