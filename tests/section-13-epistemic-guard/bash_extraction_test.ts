import * as fs from "node:fs";
import * as path from "node:path";
import { extractInspectedFilesFromCommand, resolveUserPath } from "../../src/safety/epistemic_guard";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testBashInspectionExtraction(): void {
	const ws = createTestWorkspace("epistemic_bash_");
	try {
		// Create real files for inspection
		const fooPath = path.join(ws.tempDir, "foo.ts");
		fs.writeFileSync(fooPath, "export const x = 1;", "utf8");
		const otherPath = path.join(ws.tempDir, "other.py");
		fs.writeFileSync(otherPath, "x = 1", "utf8");

		// grep on a specific file
		const files1 = extractInspectedFilesFromCommand("grep -rn 'pattern' foo.ts", ws.tempDir);
		assertPass("grep -rn extracts the existing file", files1.some((f) => f.endsWith("foo.ts")), { files1 });

		// cat on a file
		const files3 = extractInspectedFilesFromCommand("cat other.py", ws.tempDir);
		assertPass("cat extracts the absolute file", files3.some((f) => f.endsWith("other.py")), { files3 });

		// resolveUserPath round-trips
		const expanded = resolveUserPath("~/docs");
		assertPass("resolveUserPath expands ~ to user home", expanded.startsWith(process.env.HOME || process.env.USERPROFILE || ""), { expanded });

		logPass("Bash inspection extraction and path resolution verified!");
	} finally {
		ws.cleanup();
	}
}
