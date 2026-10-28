import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";

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
	const { MAX_INDEX_CHUNKS } = require("../../src/retrieval/search_chunker");
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
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}
	if (failures.length > 0) throw new Error(`File cap tests failed:\n  ${failures.join("\n  ")}`);
	console.log("✓ The index stays fresh when a workspace exceeds the chunk cap!");
}

if (require.main === module) {
	void run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
