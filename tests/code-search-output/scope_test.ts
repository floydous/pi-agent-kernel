import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { chunkFile, computeHash } from "../../src/retrieval/search_chunker";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testCodeOnlyIndexing(): Promise<void> {
	const ws = createTestWorkspace("code_search_code_only_");
	try {
		const prosePath = path.join(ws.tempDir, "notes.md");
		const textPath = path.join(ws.tempDir, "notes.txt");
		const rstPath = path.join(ws.tempDir, "notes.rst");
		fs.writeFileSync(prosePath, "# ScopeMarker\nDocumentation text.\n", "utf8");
		fs.writeFileSync(textPath, "ScopeMarker text.\n", "utf8");
		fs.writeFileSync(rstPath, "ScopeMarker reStructuredText.\n", "utf8");

		assertPass(
			"Direct chunking rejects prose files",
			chunkFile(ws.tempDir, prosePath).length === 0,
		);
		const index = new HybridSearchIndex(ws.tempDir, "lean");
		await index.syncWorkspace(true);
		const indexedFiles = new Set(
			Array.from((index as any).chunks.values() as Map<string, any>).map((chunk) => chunk.filePath),
		);
		const proseFiles = ["notes.md", "notes.txt", "notes.rst"];
		assertPass(
			"Prose files are excluded from the code index",
			proseFiles.every((file) => !indexedFiles.has(file)),
			[...indexedFiles],
		);
		assertPass(
			"Supported code files remain indexed",
			indexedFiles.has("calculator.py") && indexedFiles.has("main.py"),
			[...indexedFiles],
		);
		const internals = index as any;
		const staleContent = "ScopeMarker stale";
		const staleChunk = {
			id: "notes.md:1-1#stale",
			filePath: "notes.md",
			absolutePath: prosePath,
			startLine: 1,
			endLine: 1,
			symbolName: "stale",
			kind: "file",
			signature: "stale",
			breadcrumb: "// [File: notes.md]",
			content: staleContent,
			textForEmbedding: staleContent,
			hash: computeHash(staleContent),
		};
		internals.chunks.set(staleChunk.id, staleChunk);
		internals.fileHashes.set("notes.md", staleChunk.hash);
		internals.vectors.set(staleChunk.id, new Float32Array([1]));
		internals.bm25.addChunk(staleChunk);
		internals.bm25.recalculateStats();
		await index.updateFile(prosePath);
		assertPass(
			"Unsupported live entries are evicted",
			!internals.fileHashes.has("notes.md") &&
				!Array.from(internals.chunks.keys()).some((id) => id.startsWith("notes.md:")) &&
			!internals.vectors.has(staleChunk.id),
		);
		const hits = await index.search("ScopeMarker", { limit: 10 });
		assertPass("Prose-only content is not searchable", hits.length === 0, hits);
		await index.flushPendingSave();
		logPass("Code-only retrieval indexing verified!");
	} finally {
		ws.cleanup();
	}
}

export async function run(): Promise<void> {
	await testCodeOnlyIndexing();
}
