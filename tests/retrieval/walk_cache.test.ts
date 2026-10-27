import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceWalkCache, walkWorkspaceFiles } from "../../src/retrieval/workspace_walker";

const realFs = require("node:fs");

export async function run(): Promise<void> {
	console.log("=== Running Workspace Walk Cache Tests ===");
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pi-walkcache-"));
	const originalReaddir = realFs.readdirSync;
	try {
		const abs = (rel: string) => path.join(ws, rel);
		const write = (rel: string, text = "export const x = 1;\n") => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text); };
		const old = Math.floor(Date.now() / 1000) - 3600;
		const setTime = (rel: string, sec: number) => fs.utimesSync(abs(rel), sec, sec);
		// Age every file and directory (deepest first) so walks are not "racy".
		const age = () => {
			const all: string[] = [];
			const visit = (rel: string) => { for (const e of fs.readdirSync(abs(rel), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) visit(r); all.push(r); } };
			visit(".");
			for (const r of all.sort((a, b) => b.length - a.length)) setTime(r, old);
			setTime(".", old);
		};
		write(".gitignore", "ignored-root.ts\n");
		write("ignored-root.ts");
		write("src/a.ts");
		write("src/b.ts");
		write("src/sub/c.ts");
		write("src/sub/.gitignore", "skip.ts\n");
		write("src/sub/skip.ts");
		write("docs/d.ts");

		const opts = { rootDir: ws, maxFiles: 500, extensions: new Set([".ts"]), includeGithub: true };
		const rel = (files: string[]) => files.map((f) => path.relative(ws, f).split(path.sep).join("/")).sort();
		const cache = new WorkspaceWalkCache();
		const check = (label: string) => {
			const cached = rel(cache.walk(opts));
			assert.deepEqual(cached, rel(walkWorkspaceFiles(opts)), `${label}: cached walk differs from a fresh walk`);
			return cached;
		};
		const assertReused = (label: string) => {
			let reads = 0;
			realFs.readdirSync = (...args: any[]) => { reads++; return originalReaddir(...args); };
			const cached = rel(cache.walk(opts));
			realFs.readdirSync = originalReaddir;
			assert.equal(reads, 0, `${label}: expected the cached walk to be reused, saw ${reads} directory reads`);
			assert.deepEqual(cached, rel(walkWorkspaceFiles(opts)), `${label}: reused walk differs from a fresh walk`);
		};
		const baseline = (label: string) => { age(); check(`${label} (baseline)`); assertReused(label); };

		console.log("1. Initial walk honours root and nested ignores; unchanged walk is reused...");
		baseline("initial");
		assert.deepEqual(check("initial"), ["docs/d.ts", "src/a.ts", "src/b.ts", "src/sub/c.ts"]);

		console.log("2. Add, remove, rename a file in a subdirectory...");
		baseline("add");
		write("src/sub/e.ts");
		assert.ok(check("add").includes("src/sub/e.ts"));
		baseline("remove");
		fs.rmSync(abs("src/sub/e.ts"));
		assert.ok(!check("remove").includes("src/sub/e.ts"));
		baseline("rename-file");
		fs.renameSync(abs("src/sub/c.ts"), abs("src/sub/c2.ts"));
		assert.ok(check("rename-file").includes("src/sub/c2.ts"));

		console.log("3. Rename a subdirectory...");
		baseline("rename-dir");
		fs.renameSync(abs("src/sub"), abs("src/sub2"));
		assert.ok(check("rename-dir").includes("src/sub2/c2.ts"));

		console.log("4. Nested .gitignore edited in place (directory mtime forced unchanged)...");
		baseline("nested-edit");
		write("src/sub2/.gitignore", "skip.ts\nc2.ts\n");
		setTime("src/sub2", old);
		assert.ok(!check("nested-edit").includes("src/sub2/c2.ts"), "newly ignored file must disappear");

		console.log("5. New nested .gitignore created (directory mtime forced unchanged)...");
		baseline("nested-new");
		write("docs/.gitignore", "d.ts\n");
		setTime("docs", old);
		assert.ok(!check("nested-new").includes("docs/d.ts"));

		console.log("6. Root .gitignore edited (root mtime forced unchanged)...");
		baseline("root-edit");
		write(".gitignore", "ignored-root.ts\nsrc/b.ts\n");
		setTime(".", old);
		assert.ok(!check("root-edit").includes("src/b.ts"));

		console.log("7. Racy case: entry added right after a walk with the directory mtime restored exactly...");
		age();
		const recent = Math.floor(Date.now() / 1000);
		setTime("src", recent);
		check("racy baseline");
		write("src/racy.ts");
		setTime("src", recent);
		assert.ok(check("racy").includes("src/racy.ts"), "racy walk must not be reused");
	} finally {
		realFs.readdirSync = originalReaddir;
		fs.rmSync(ws, { recursive: true, force: true });
	}
	console.log("✓ Walk cache matches fresh walks for every change and reuses unchanged walks!");
}
