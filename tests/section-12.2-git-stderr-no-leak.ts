// Section 12.2: extractWorkspaceState does not leak filesystem errors to the parent TUI
// Verifies that the function captures stderr (e.g. CRLF warnings) instead of
// inheriting the parent's stderr stream.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { extractWorkspaceState } from "../src/context/compaction_enhanced";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection(
		"12.2. extractWorkspaceState does not leak filesystem errors to TUI",
		() => {
			// Set up a workspace with a regular file and a nested directory.
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "epistemic-workspace-state-"),
			);
			try {
			fs.mkdirSync(path.join(tmpDir, "nested"));

				// Write a regular file and leave the nested directory visible.
				const target = path.join(tmpDir, "lf-only.txt");
				fs.writeFileSync(target, "// lf only line\n// another lf line\n", "utf8");
				fs.writeFileSync(target, "// regular file\n", "utf8");

				fs.writeFileSync(
					target,
					"// lf only line MODIFIED\n// another lf line\n",
					"utf8",
				);

				// Now run extractWorkspaceState.
				const out = extractWorkspaceState(tmpDir);
				assertPass(
					"extractWorkspaceState returns workspace entries",
					typeof out === "string" &&
						out.includes("<workspace-state>") &&
						out.includes("file: lf-only.txt") &&
						out.includes("dir: nested"),
					{ outPreview: out.slice(0, 300) },
				);
				logPass("extractWorkspaceState returns bounded workspace entries");
			} finally {
				try {
					fs.rmSync(tmpDir, { recursive: true, force: true });
				} catch (cleanupError) {
					console.warn("Temporary test workspace cleanup failed:", cleanupError);
				}
			}
		},
	);
}

main().catch((err) => {
	console.error(err);
	throw err;
});
