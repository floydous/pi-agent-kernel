// Section 12.2: bounded workspace-state extraction.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { extractWorkspaceState } from "../src/context/compaction_enhanced";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("12.2. Bounded workspace-state extraction", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "epistemic-workspace-state-"),
		);
		try {
			fs.mkdirSync(path.join(tmpDir, "nested"));
			fs.writeFileSync(
				path.join(tmpDir, "workspace.txt"),
				"// regular file\n",
				"utf8",
			);

			const out = extractWorkspaceState(tmpDir);
			assertPass(
				"extractWorkspaceState returns workspace entries",
				typeof out === "string" &&
					out.includes("<workspace-state>") &&
					out.includes("file: workspace.txt") &&
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
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
