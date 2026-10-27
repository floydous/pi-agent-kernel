import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTestPath } from "../../src/retrieval/tag_extractor";
import { registerCodeSearchTool } from "../../src/tools/code_search_tool";

// Test files restate behavior in prose, so they outrank the implementing source for a prose query.
const SOURCES = Array.from({ length: 6 }, (_, i) => [`src/backoff${i}.ts`, `export function retryStep${i}(attempt: number): number {\n\treturn attempt * ${i + 1}; // retry delay\n}\n`]);
const TESTS = Array.from({ length: 4 }, (_, i) => [`tests/backoff${i}.test.ts`, `describe("retry delay backoff ${i}", () => {\n\tit("retry delay backoff grows", () => {});\n\tit("retry delay backoff caps", () => {});\n\tit("retry delay backoff resets", () => {});\n});\n`]);
const QUERY = "retry delay backoff";
const ids = (hits: any[]) => hits.map((h) => h.chunk.id);

export async function run(): Promise<void> {
	console.log("=== Running Source/Test Separation Tests ===");
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-separation-pidir-"));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-separation-ws-"));
	process.env.PI_DIR = piDir;
	try {
		for (const [file, content] of [...SOURCES, ...TESTS]) {
			fs.mkdirSync(path.join(workspace, path.dirname(file)), { recursive: true });
			fs.writeFileSync(path.join(workspace, file), content);
		}
		const { HybridSearchIndex } = require("../../src/retrieval/search_index");
		const index = new HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await index.syncWorkspace(true);

		console.log("1. Precondition: without separation, tests take top slots...");
		const plain = await index.search(QUERY, { limit: 5 });
		assert.ok(plain.slice(0, 5).some((h: any) => isTestPath(h.chunk.filePath)), "fixture must rank a test in the top 5");

		console.log("2. With separation: `limit` source hits first, then at most 3 test hits...");
		const separated = await index.search(QUERY, { limit: 5, separateTests: true });
		const firstTest = separated.findIndex((h: any) => isTestPath(h.chunk.filePath));
		assert.equal(firstTest, 5, "the first 5 hits are source");
		assert.ok(separated.slice(5).every((h: any) => isTestPath(h.chunk.filePath)));
		assert.equal(separated.length - 5, 3, "3 test hits follow by default");
		const limited = await index.search(QUERY, { limit: 5, separateTests: true, testLimit: 1 });
		assert.equal(limited.filter((h: any) => isTestPath(h.chunk.filePath)).length, 1, "testLimit caps the test hits");

		console.log("3. A query or file pattern aimed at tests keeps the normal ranking...");
		assert.deepEqual(ids(await index.search(`${QUERY} tests`, { limit: 5, separateTests: true })), ids(await index.search(`${QUERY} tests`, { limit: 5 })));
		assert.deepEqual(ids(await index.search(QUERY, { limit: 5, separateTests: true, filePattern: "tests/" })), ids(await index.search(QUERY, { limit: 5, filePattern: "tests/" })));
		await index.flushPendingSave?.(true);

		console.log("4. The code_search tool asks for separation...");
		let tool: any;
		let options: any;
		registerCodeSearchTool({ registerTool(t: any) { tool = t; } } as any, {
			getSessionId: () => "separation",
			getSearchIndex: () => ({ search: async (_q: string, o: any) => { options = o; return []; } }),
		} as any);
		await tool.execute("s1", { query: QUERY }, null, () => {}, { cwd: workspace });
		assert.equal(options?.separateTests, true);

		console.log("✓ Source hits come first; tests follow, unless the search targets tests!");
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	void run();
}
