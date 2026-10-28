import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { registerCodeSearchTool } from "../../src/tools/code_search_tool";

/** A C file of `count` one-line-body functions: one chunk each, so a few files exceed MAX_INDEX_CHUNKS. */
const cFunctions = (prefix: string, count: number, offset = 0) =>
	Array.from({ length: count }, (_, i) => `int ${prefix}_${i}(int x) {\n\treturn x + ${i + offset};\n}\n`).join("\n");

/** Counts full syncs so tests can assert that a warm search does not resync. */
function countSyncs(index: any): any {
	const original = index.performSyncWorkspace.bind(index);
	index.syncs = 0;
	index.performSyncWorkspace = (...args: unknown[]) => {
		index.syncs++;
		return original(...args);
	};
	return index;
}

export async function run(): Promise<void> {
	console.log("=== Running Index File Cap Tests ===");
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-cap-pidir-"));
	process.env.PI_DIR = piDir;
	const { HybridSearchIndex } = require("../../src/retrieval/search_index");
	const { findChunkableFiles, MAX_INDEX_CHUNKS } = require("../../src/retrieval/search_chunker");
	const { walkWorkspaceFiles } = require("../../src/retrieval/workspace_walker");
	const workspaces: string[] = [];
	const workspace = (files: Record<string, string>) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-cap-ws-"));
		workspaces.push(dir);
		for (const [rel, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
			fs.writeFileSync(path.join(dir, rel), content);
		}
		return dir;
	};
	const newIndex = (dir: string) => countSyncs(new HybridSearchIndex(dir, "lean", { projectTrusted: true }));
	const indexedFiles = (index: any) => [...index.fileHashes.keys()].sort();
	const failures: string[] = [];
	const section = async (label: string, body: () => Promise<void>) => {
		console.log(label);
		try {
			await body();
		} catch (error: any) {
			failures.push(`${label} ${String(error?.message).split("\n")[0]}`);
		}
	};

	try {
		await TreeSitterEngine.getInstance().loadLanguages([".c"]);
		assert.ok(3 * 4000 > MAX_INDEX_CHUNKS && 2 * 4000 + 1 < MAX_INDEX_CHUNKS, "fixtures assume a 10,000-chunk cap");
		const big = { "m0.c": cFunctions("a", 4000), "m1.c": cFunctions("b", 4000), "m2.c": cFunctions("c", 4000) };
		const capped = workspace(big);
		const index = newIndex(capped);

		await section("T1. A workspace over the chunk cap syncs, searches, and stays fresh...", async () => {
			await index.syncWorkspace(true);
			const status = index.getStatus();
			assert.equal(status.skippedFiles, 1, "the overflow file is reported as skipped");
			assert.deepEqual(indexedFiles(index), ["m0.c", "m1.c"]);
			assert.ok((await index.search("return x plus", { limit: 3 })).length > 0, "search returns hits");
			const syncs = index.syncs;
			await index.search("return x plus", { limit: 3 });
			assert.equal(index.syncs, syncs, "a second search must not resync");
			const fresh = new HybridSearchIndex(capped, "lean", { projectTrusted: true });
			assert.ok((await fresh.search("return x plus", { limit: 3 })).length > 0, "a new session's first search returns hits");
			await fresh.flushPendingSave?.(true);
		});

		await section("T2. Editing the skipped file resyncs once; deleting an indexed file lets it in...", async () => {
			fs.writeFileSync(path.join(capped, "m2.c"), cFunctions("c", 4000, 1));
			const syncs = index.syncs;
			await index.search("return x plus", { limit: 3 });
			assert.equal(index.syncs, syncs + 1, "exactly one resync after editing the skipped file");
			assert.equal(index.getStatus().skippedFiles, 1);
			await index.search("return x plus", { limit: 3 });
			assert.equal(index.syncs, syncs + 1, "consistent after the resync");
			fs.rmSync(path.join(capped, "m0.c"));
			await index.search("return x plus", { limit: 3 });
			assert.deepEqual(indexedFiles(index), ["m1.c", "m2.c"]);
			assert.equal(index.getStatus().skippedFiles, 0);
		});
		await index.flushPendingSave?.(true);

		await section("T3. An incremental update that crosses the chunk cap, then search, does not throw...", async () => {
			const dir = workspace({ "m0.c": big["m0.c"], "m1.c": big["m1.c"], "small.c": cFunctions("s", 1) });
			const incremental = newIndex(dir);
			await incremental.syncWorkspace(true);
			assert.deepEqual(indexedFiles(incremental), ["m0.c", "m1.c", "small.c"]);
			fs.writeFileSync(path.join(dir, "small.c"), cFunctions("s", 4000));
			await incremental.updateFile(path.join(dir, "small.c"));
			assert.ok((await incremental.search("return x plus", { limit: 3 })).length > 0);
			assert.deepEqual(indexedFiles(incremental), ["m0.c", "m1.c"]);
			assert.equal(incremental.getStatus().skippedFiles, 1);
			await incremental.flushPendingSave?.(true);
		});

		await section("T4. Files are ranked source < test < vendored, then by path code units, for any walk order...", async () => {
			const root = path.resolve(os.tmpdir(), "file-cap-virtual-root");
			const expected = [
				"Zebra.c", "a.c", "src-x/a.c", "src/a.c", "src/server.c", "srcA/x.c", // source, code-unit order
				"tests/unit/test_x.c", // test
				"deps/lua/src/lapi.c", "deps/x/test/foo_test.c", "third_party/y.c", // vendored (a vendored test is vendored)
			];
			const shuffles = [expected.slice().reverse(), [...expected.slice(5), ...expected.slice(0, 5)], expected.slice()];
			for (const shuffled of shuffles) {
				const fakeWalk = { walk: () => shuffled.map((rel) => path.join(root, rel)) };
				const ranked = findChunkableFiles(root, 100, fakeWalk).map((f: string) => path.relative(root, f).replace(/\\/g, "/"));
				assert.deepEqual(ranked, expected);
			}
			const fakeWalk = { walk: () => shuffles[0].map((rel) => path.join(root, rel)) };
			assert.deepEqual(findChunkableFiles(root, 3, fakeWalk).map((f: string) => path.basename(f)), ["Zebra.c", "a.c", "a.c"]);
		});

		await section("T5. The file cap keeps src/ over deps/; the chunk budget goes to src/ first...", async () => {
			const dir = workspace({ "deps/a.c": "int a;\n", "deps/b.c": "int b;\n", "deps/c.c": "int c;\n", "src/y.c": "int y;\n", "src/z.c": "int z;\n" });
			const rel = (files: string[]) => files.map((f) => path.relative(dir, f).replace(/\\/g, "/"));
			assert.deepEqual(rel(walkWorkspaceFiles({ rootDir: dir, maxFiles: 3, extensions: new Set([".c"]) })), ["deps/a.c", "deps/b.c", "deps/c.c"], "fixture: the walk lists deps/ first");
			assert.deepEqual(rel(findChunkableFiles(dir, 3)), ["src/y.c", "src/z.c", "deps/a.c"]);
			const budget = workspace({ "deps/big.c": big["m0.c"], "deps/big2.c": big["m1.c"], "src/z.c": big["m2.c"] });
			const budgetIndex = newIndex(budget);
			await budgetIndex.syncWorkspace(true);
			assert.deepEqual(indexedFiles(budgetIndex), ["deps/big.c", "src/z.c"]);
			assert.equal(budgetIndex.getStatus().skippedFiles, 1);
			await budgetIndex.flushPendingSave?.(true);
		});

		await section("T6. Index status and code_search report files left out of the index...", async () => {
			const files: Record<string, string> = { "deps/v1.c": "int v1;\n", "deps/v2.c": "int v2;\n" };
			for (let i = 0; i < 500; i++) files[`src/f${String(i).padStart(3, "0")}.c`] = `int f${i};\n`;
			const over = newIndex(workspace(files));
			await over.syncWorkspace(true);
			const status = over.getStatus();
			assert.equal(status.fileCount, 500);
			assert.equal(status.indexableFiles, 502);
			assert.deepEqual(status.notIndexed, { source: 0, test: 0, vendored: 2 });
			assert.deepEqual(status.notIndexedDirs, ["deps/"]);
			assert.equal(status.walkTruncated, false);
			await over.flushPendingSave?.(true);

			const hit = { chunk: { id: "src/a.c:1-1", filePath: "src/a.c", absolutePath: path.join(os.tmpdir(), "src/a.c"), startLine: 1, endLine: 1, kind: "file", symbolName: "a.c", breadcrumb: "", content: "int a;", signature: "File" }, rrfScore: 1, signal: "lexical", matches: ["a"] };
			const output = async (status: any, hits: any[] = [hit]) => {
				let tool: any;
				registerCodeSearchTool({ registerTool(t: any) { tool = t; } } as any, {
					getSessionId: () => "file-cap",
					getSearchIndex: () => ({ search: async () => hits, getStatus: () => ({ effectiveProfile: "lean", vectorCount: 0, chunkCount: 1, grammarIssues: [], ...status }) }),
				} as any);
				return (await tool.execute("f1", { query: "alpha" }, null, () => {}, { cwd: os.tmpdir() })).content[0].text as string;
			};
			const partial = { indexableFiles: 1001, notIndexed: { source: 0, test: 0, vendored: 445 }, notIndexedDirs: ["deps/"], walkTruncated: false };
			const notice = "[Notice: index covers 556 of 1,001 indexable files (index limits); not indexed: 445 vendored (deps/); use rg for those paths]\n\n";
			assert.ok((await output(partial)).startsWith(notice));
			assert.ok((await output(partial, [])).startsWith(notice), "the notice also precedes a no-hit answer");
			assert.ok((await output({ indexableFiles: 20000, notIndexed: { source: 19000, test: 300, vendored: 200 }, notIndexedDirs: ["src/", "lib/", "./"], walkTruncated: true }))
				.startsWith("[Notice: index covers 500 of ≥ 20,000 indexable files (index limits); not indexed: 19,000 source, 300 test, 200 vendored (src/, lib/, ./); use rg for those paths]"));
			const complete = { indexableFiles: 3, notIndexed: { source: 0, test: 0, vendored: 0 }, notIndexedDirs: [], walkTruncated: false };
			assert.equal(await output(complete), await output({}), "no notice, byte-identical output, when everything is indexed");
			assert.equal((await output(complete)).includes("[Notice"), false);
		});

		await section("T7. Under the caps the file set and sync order are those of an unranked walk...", async () => {
			const dir = workspace({ "deps/a.c": "int da;\n", "src/b.c": "int sb;\n", "srcA/x.c": "int sx;\n", "src-x/a.c": "int xa;\n", "tests/test_c.c": "int tc;\n", "Z.c": "int z;\n", "a.c": "int a;\n" });
			const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
			const expected = walkWorkspaceFiles({ rootDir: dir, maxFiles: 500, extensions: new Set([".c"]) }).sort(compare)
				.map((f: string) => path.relative(dir, f).replace(/\\/g, "/"));
			const under = newIndex(dir);
			await under.syncWorkspace(true);
			const insertion = [...new Set<string>([...under.chunks.values()].map((c: any) => c.filePath))];
			assert.deepEqual(insertion, expected);
			assert.equal(under.getStatus().indexableFiles, 7);
			assert.deepEqual(under.getStatus().notIndexed, { source: 0, test: 0, vendored: 0 });
			await under.flushPendingSave?.(true);
		});
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}
	if (failures.length > 0) throw new Error(`File cap tests failed:\n  ${failures.join("\n  ")}`);
	console.log("✓ The index stays fresh over the chunk cap, ranks files by tier, and reports what it left out!");
}

if (require.main === module) {
	void run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
