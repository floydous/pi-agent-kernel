import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testSearchScope(): Promise<void> {
	const ws = createTestWorkspace("code_search_scope_");
	try {
		const prosePath = path.join(ws.tempDir, "notes.md");
		const textPath = path.join(ws.tempDir, "notes.txt");
		fs.writeFileSync(prosePath, "# ScopeMarker\nThis prose mentions ScopeMarker.\n", "utf8");
		fs.writeFileSync(textPath, "ScopeMarker prose text\n", "utf8");
		const index = new HybridSearchIndex(ws.tempDir, "lean");

		const defaultHits = await index.search("ScopeMarker", { limit: 10 });
		assertPass("Default search excludes prose chunks", defaultHits.every((hit) => !/\.(md|txt|rst|mdx)$/i.test(hit.chunk.filePath)), defaultHits);

		const proseHits = await index.search("ScopeMarker", { limit: 10, scope: "prose" });
		assertPass("Prose scope includes prose chunks", proseHits.length >= 1 && proseHits.every((hit) => /\.(md|txt|rst|mdx)$/i.test(hit.chunk.filePath)), proseHits);

		const allHits = await index.search("ScopeMarker", { limit: 10, scope: "all" });
		assertPass("All scope includes prose and code candidates", allHits.some((hit) => /\.(md|txt|rst|mdx)$/i.test(hit.chunk.filePath)), allHits);
		logPass("Code-search scope filtering verified!");
	} finally {
		ws.cleanup();
	}
}

export async function run(): Promise<void> {
	await testSearchScope();
}
