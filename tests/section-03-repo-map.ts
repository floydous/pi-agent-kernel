// Section 3: Repository Map & PageRank
// Tests computeRepoMap on a temporary workspace containing a real Python file.

import * as path from "node:path";
import { computeRepoMap } from "../src/retrieval/repomap";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("3. Repository Map & PageRank", () => {
		const ws = createTestWorkspace();
		try {
			const repoMap = computeRepoMap(ws.tempDir, 1024);
			console.log(repoMap);
			assertPass(
				"Repo map generation test passed",
				repoMap.includes("calculator.py") && repoMap.includes("def calculate_tax"),
				{ repoMap: repoMap.slice(0, 200) }
			);
			logPass("Repo map generation test passed!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
