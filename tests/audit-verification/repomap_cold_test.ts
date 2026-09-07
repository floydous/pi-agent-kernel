import { computeRepoMap } from "../../src/retrieval/repomap";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export async function testRepomapColdStart(): Promise<void> {
	// Create a polyglot workspace and ensure computeRepoMap doesn't throw on a cold engine
	const ws = createPolyglotWorkspace("repomap_cold_");
	try {
		await TreeSitterEngine.getInstance().init();
		const map = computeRepoMap(ws.tempDir, 1024);
		assertPass("computeRepoMap returns non-empty string on polyglot workspace", map.length > 0, { length: map.length });
		logPass("Repomap cold-start verified across polyglot workspace!");
	} finally {
		ws.cleanup();
	}
}
