import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerEditTool } from "../../src/tools/edit_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";
import { logPass } from "../_setup";

function registerEdit(deps: any): any {
	const pi: any = {
		registerTool(tool: any) {
			pi.tool = tool;
		},
	};
	registerEditTool(pi, deps);
	return pi.tool;
}

export async function run(): Promise<void> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-multi-edit-"));
	const sessionId = `multi-edit-${path.basename(tempDir)}`;
	globalEpistemicGuard.resetSession(sessionId);

	try {
		const config = {
			safety: { enable_epistemic_guard: true, max_total_bytes: 20 * 1024 },
			editing: { default_anchors: false, read_mode: "plain" },
		};
		const edit = registerEdit({
			getSessionId: () => sessionId,
			getConfig: () => config,
			invalidateSearchFile: () => {},
		});
		const ctx = { cwd: tempDir };

		const file1 = path.join(tempDir, "mod1.ts");
		const file2 = path.join(tempDir, "mod2.ts");
		fs.writeFileSync(file1, "export const count = 1;\nexport const name = 'old';\n");
		fs.writeFileSync(file2, "export function hello() {\n  return 'hello';\n}\n");

		// Record initial read in EpistemicGuard
		globalEpistemicGuard.recordFileRead(file1, sessionId, tempDir, fs.readFileSync(file1, "utf8"), {
			coverage: { complete: true, ranges: [] },
			provenance: "read",
		});
		globalEpistemicGuard.recordFileRead(file2, sessionId, tempDir, fs.readFileSync(file2, "utf8"), {
			coverage: { complete: true, ranges: [] },
			provenance: "read",
		});

		// 1. Atomic multi-file edit via `files` array
		const res1 = await edit.execute(
			"call-1",
			{
				files: [
					{ path: "mod1.ts", search: "export const count = 1;", replace: "export const count = 42;" },
					{ path: "mod2.ts", search: "return 'hello';", replace: "return 'world';" },
				],
			},
			undefined,
			undefined,
			ctx,
		);

		assert.equal(res1.isError, undefined);
		assert.ok(res1.content[0].text.includes("Successfully applied edits to 2 files"));
		assert.equal(fs.readFileSync(file1, "utf8"), "export const count = 42;\nexport const name = 'old';\n");
		assert.equal(fs.readFileSync(file2, "utf8"), "export function hello() {\n  return 'world';\n}\n");

		// 2. Verify EpistemicGuard mutation continuity: both files should be eligible for sequential edits without re-reading
		const seqCheck1 = globalEpistemicGuard.checkReadPrecondition(file1, "edit", sessionId, tempDir, true, [{ startLine: 1, endLine: 1 }]);
		const seqCheck2 = globalEpistemicGuard.checkReadPrecondition(file2, "edit", sessionId, tempDir, true, [{ startLine: 1, endLine: 1 }]);
		assert.equal(seqCheck1.allowed, true, "mod1 maintains mutation continuity");
		assert.equal(seqCheck2.allowed, true, "mod2 maintains mutation continuity");

		// 3. Multi-file edit via `edits` with embedded `path`
		const res2 = await edit.execute(
			"call-2",
			{
				edits: [
					{ path: "mod1.ts", search: "export const name = 'old';", replace: "export const name = 'new';" },
					{ path: "mod2.ts", search: "return 'world';", replace: "return 'universe';" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(res2.isError, undefined);
		assert.equal(fs.readFileSync(file1, "utf8"), "export const count = 42;\nexport const name = 'new';\n");
		assert.equal(fs.readFileSync(file2, "utf8"), "export function hello() {\n  return 'universe';\n}\n");

		// 4. Preflight atomicity check: if one file fails search block not found, nothing is written
		const resFail = await edit.execute(
			"call-3",
			{
				files: [
					{ path: "mod1.ts", search: "export const count = 42;", replace: "export const count = 100;" },
					{ path: "mod2.ts", search: "NON_EXISTENT_STRING", replace: "something" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(resFail.isError, true);
		// mod1 must NOT have changed because mod2 failed preflight
		assert.equal(fs.readFileSync(file1, "utf8"), "export const count = 42;\nexport const name = 'new';\n");

		// 5. Duplicate canonical path rejection
		const resDup = await edit.execute(
			"call-4",
			{
				files: [
					{ path: "mod1.ts", search: "export const count = 42;", replace: "export const count = 100;" },
					{ path: "./mod1.ts", search: "export const name = 'new';", replace: "export const name = 'dup';" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(resDup.isError, true);
		assert.ok(resDup.content[0].text.includes("Duplicate target path"));

		// 6. Rollback on verification/syntax error in second file
		const resRollback = await edit.execute(
			"call-5",
			{
				files: [
					{ path: "mod1.ts", search: "export const count = 42;", replace: "export const count = 999;" },
					// Introduce fatal syntax error in file 2 that triggers verification failure
					{ path: "mod2.ts", search: "return 'universe';", replace: "return 'broken' {{{{ invalid syntax" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(resRollback.isError, true);
		assert.ok(resRollback.content[0].text.includes("ROLLED BACK"));
		// mod1 must have rolled back to 42, NOT 999!
		assert.equal(fs.readFileSync(file1, "utf8"), "export const count = 42;\nexport const name = 'new';\n");

		logPass("Multi-file atomic edit, resilient edits-with-path, duplicate check, preflight atomicity, rollback, and mutation continuity verified!");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}
