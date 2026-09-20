import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerReadTool } from "../../src/tools/read_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";
import { logPass } from "../_setup";

function registerRead(deps: any): any {
	const pi: any = {
		registerTool(tool: any) {
			pi.tool = tool;
		},
	};
	registerReadTool(pi, deps);
	return pi.tool;
}

function text(result: any): string {
	return result.content?.find((part: any) => part.type === "text")?.text || "";
}

export async function run(): Promise<void> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-batch-read-"));
	const sessionId = `batch-read-${path.basename(tempDir)}`;
	globalEpistemicGuard.resetSession(sessionId);

	try {
		const config = {
			safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
			editing: { default_anchors: false, read_mode: "plain" },
		};
		const read = registerRead({
			getSessionId: () => sessionId,
			getConfig: () => config,
		});
		const ctx = { cwd: tempDir };

		const fileA = path.join(tempDir, "fileA.ts");
		const fileB = path.join(tempDir, "fileB.ts");
		fs.writeFileSync(fileA, "export const a = 1;\nexport const a2 = 2;");
		fs.writeFileSync(fileB, "export const b = 10;\nexport const b2 = 20;");

		// Test 1: Reading via paths: string[]
		const res1 = await read.execute("call-1", { paths: ["fileA.ts", "fileB.ts"] }, undefined, undefined, ctx);
		const txt1 = text(res1);
		assert.equal(res1.isError, false);
		assert.ok(txt1.includes("=== file: fileA.ts"));
		assert.ok(txt1.includes("export const a = 1;"));
		assert.ok(txt1.includes("=== file: fileB.ts"));
		assert.ok(txt1.includes("export const b = 10;"));
		assert.equal(res1.details.count, 2);

		// Test 2: Verify EpistemicGuard authorized both files
		const authA = globalEpistemicGuard.checkReadPrecondition(fileA, "edit", sessionId, tempDir, true, [{ startLine: 1, endLine: 1 }]);
		const authB = globalEpistemicGuard.checkReadPrecondition(fileB, "edit", sessionId, tempDir, true, [{ startLine: 1, endLine: 1 }]);
		assert.equal(authA.allowed, true, "fileA authorized by batch read");
		assert.equal(authB.allowed, true, "fileB authorized by batch read");

		// Test 3: Resilient alias path: string[]
		const res2 = await read.execute("call-2", { path: ["fileA.ts", "fileB.ts"] }, undefined, undefined, ctx);
		assert.equal(res2.isError, false);
		assert.equal(res2.details.count, 2);

		// Test 4: Mixed missing and existing files
		const res3 = await read.execute("call-3", { paths: ["fileA.ts", "nonexistent.ts"] }, undefined, undefined, ctx);
		const txt3 = text(res3);
		assert.equal(res3.isError, false, "Partial batch read is not a total failure");
		assert.ok(txt3.includes("=== file: nonexistent.ts ===\nFile not found: nonexistent.ts"));
		assert.ok(txt3.includes("export const a = 1;"));

		// Test 5: Empty paths returns error
		const res4 = await read.execute("call-4", { paths: [] }, undefined, undefined, ctx);
		assert.equal(res4.isError, true);

		// Test 6: Max batch path capping (>20 paths)
		const manyPaths: string[] = [];
		for (let i = 0; i < 25; i++) {
			const fn = `file_${i}.ts`;
			fs.writeFileSync(path.join(tempDir, fn), `export const f${i} = ${i};`);
			manyPaths.push(fn);
		}
		const res5 = await read.execute("call-5", { paths: manyPaths }, undefined, undefined, ctx);
		const txt5 = text(res5);
		assert.equal(res5.details.count, 20, "capped at 20 files");
		assert.ok(txt5.includes("Truncated to first 20 files"));

		// Test 7: Cumulative byte limit capping (24KB)
		const bigA = path.join(tempDir, "bigA.ts");
		const bigB = path.join(tempDir, "bigB.ts");
		const bigC = path.join(tempDir, "bigC.ts");
		fs.writeFileSync(bigA, "x".repeat(15 * 1024));
		fs.writeFileSync(bigB, "y".repeat(15 * 1024));
		fs.writeFileSync(bigC, "z".repeat(15 * 1024));
		const res6 = await read.execute("call-6", { paths: ["bigA.ts", "bigB.ts", "bigC.ts"] }, undefined, undefined, ctx);
		const txt6 = text(res6);
		assert.ok(txt6.includes("batch byte limit reached (24KB)"), "truncates when cumulative batch exceeds 24KB");

		// Test 8: Per-file batch line limit (150 lines)
		const longFile = path.join(tempDir, "long.ts");
		fs.writeFileSync(longFile, Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n"));
		const res7 = await read.execute("call-7", { paths: ["fileA.ts", "long.ts"] }, undefined, undefined, ctx);
		const txt7 = text(res7);
		assert.ok(txt7.includes("returned lines 1-150 of 400"), "per-file batch window capped at 150 lines");

		logPass("Batch multi-file read, limits, EpistemicGuard authorization, and fault tolerance verified!");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}
