import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realFs = require("node:fs");

export async function run(): Promise<void> {
	console.log("=== Running Stat-Based Freshness Tests ===");
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fresh-pidir-"));
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fresh-ws-"));
	process.env.PI_DIR = piDir;
	const originalOpenSync = realFs.openSync;
	try {
		const { HybridSearchIndex } = require("../../src/retrieval/search_index");
		const write = (rel: string, text: string, mtimeSec?: number) => {
			const abs = path.join(ws, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, text);
			if (mtimeSec !== undefined) fs.utimesSync(abs, mtimeSec, mtimeSec);
		};
		const old = Math.floor(Date.now() / 1000) - 3600;
		write("src/a.ts", "export function zebrakite(): number {\n\treturn 1;\n}\n", old);
		write("src/b.ts", "export function walrusmnt(): number {\n\treturn 2;\n}\n", old);
		const index = new HybridSearchIndex(ws, "lean", { projectTrusted: true });
		await index.syncWorkspace(true);
		const files = async (q: string) => [...new Set((await index.search(q, { limit: 5 })).map((h: any) => h.chunk.filePath))];

		console.log("1. Unchanged workspace: repeat query opens no workspace files (fast path)...");
		assert.deepEqual(await files("zebrakite"), ["src/a.ts"]);
		let opens = 0;
		realFs.openSync = (p: any, ...rest: any[]) => { if (String(p).startsWith(ws)) opens++; return originalOpenSync(p, ...rest); };
		assert.deepEqual(await files("walrusmnt"), ["src/b.ts"]);
		realFs.openSync = originalOpenSync;
		assert.equal(opens, 0, `expected no workspace file opens on an unchanged query, saw ${opens}`);

		console.log("2. Same-size rewrite with a new mtime is detected...");
		write("src/a.ts", "export function otterplum(): number {\n\treturn 1;\n}\n", old + 5);
		assert.deepEqual(await files("otterplum"), ["src/a.ts"]);
		assert.deepEqual(await files("zebrakite"), [], "old content must be gone");

		console.log("3. Racy case: same-size rewrite with an identical mtime right after a read is detected...");
		const now = Math.floor(Date.now() / 1000);
		write("src/a.ts", "export function lynxcider(): number {\n\treturn 1;\n}\n", now);
		assert.deepEqual(await files("lynxcider"), ["src/a.ts"]);
		write("src/a.ts", "export function ibexmossy(): number {\n\treturn 1;\n}\n", now);
		assert.deepEqual(await files("ibexmossy"), ["src/a.ts"], "racy same-size, same-mtime rewrite must be re-read");

		console.log("4. Added, deleted, and renamed files are detected...");
		write("src/c.ts", "export function heronsalt(): number {\n\treturn 3;\n}\n", old);
		assert.deepEqual(await files("heronsalt"), ["src/c.ts"]);
		fs.rmSync(path.join(ws, "src/b.ts"));
		assert.deepEqual(await files("walrusmnt"), [], "deleted file must not be returned");
		fs.renameSync(path.join(ws, "src/c.ts"), path.join(ws, "src/renamed.ts"));
		assert.deepEqual(await files("heronsalt"), ["src/renamed.ts"]);

		console.log("5. Ignore-config change is detected...");
		write(".gitignore", "src/renamed.ts\n");
		assert.deepEqual(await files("heronsalt"), [], "newly ignored file must not be returned");

		await index.flushPendingSave?.(true);
	} finally {
		realFs.openSync = originalOpenSync;
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(ws, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}
	console.log("✓ Stat-based freshness detects every change and skips unchanged files!");
}
