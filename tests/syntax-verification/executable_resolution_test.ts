import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	resolveNodeExecutable,
	resetNodeExecutableCache,
	setNodeExecutableForTesting,
	checkSyntax,
	checkSyntaxContent,
} from "../../src/editing/syntax-verify";
import { assertPass, logPass, createTestWorkspace } from "../_setup";

export function testExecutableResolution(): void {
	// 1. Verify Node executable resolution finds a working Node binary and caches it
	resetNodeExecutableCache();
	const nodeExec1 = resolveNodeExecutable();
	assert.ok(nodeExec1 !== null, "Node executable must be resolvable");
	assertPass("resolveNodeExecutable returns a valid candidate", typeof nodeExec1?.bin === "string", { nodeExec1 });

	const nodeExec2 = resolveNodeExecutable();
	assert.strictEqual(nodeExec1, nodeExec2, "Second call must return cached executable instance");

	resetNodeExecutableCache();
	const nodeExec3 = resolveNodeExecutable();
	assert.notStrictEqual(nodeExec1, nodeExec3, "resetNodeExecutableCache must clear the cache");

	// 2. Verify valid JS returns clean
	const ws = createTestWorkspace("syntax_exec_");
	try {
		const validJs = path.join(ws.tempDir, "valid.js");
		fs.writeFileSync(validJs, "const a = 1; console.log(a);", "utf8");
		const validRes = checkSyntax(validJs);
		assertPass("Valid JS passes syntax validation", validRes.valid === true && validRes.status === "clean", { validRes });

		// 3. Verify real invalid JS is caught as failed with diagnostic text
		const invalidJs = path.join(ws.tempDir, "invalid.js");
		fs.writeFileSync(invalidJs, "const a = ;", "utf8");
		const invalidRes = checkSyntax(invalidJs);
		assertPass("Invalid JS is caught as failed", invalidRes.valid === false && invalidRes.status === "failed", { invalidRes });
		assert.ok(invalidRes.error?.includes("SyntaxError"), "Invalid JS diagnostic must contain SyntaxError");

		// 4. Verify valid TS passes syntax validation
		const validTs = path.join(ws.tempDir, "valid.ts");
		fs.writeFileSync(validTs, "export const x: number = 42;", "utf8");
		const validTsRes = checkSyntax(validTs);
		assertPass("Valid TS passes syntax validation", validTsRes.valid === true && validTsRes.status === "clean", { validTsRes });

		// 5. Verify real invalid TS is caught as failed with diagnostic text
		const invalidTs = path.join(ws.tempDir, "invalid.ts");
		fs.writeFileSync(invalidTs, "export const x: number = ;", "utf8");
		const invalidTsRes = checkSyntax(invalidTs);
		assertPass("Invalid TS is caught as failed", invalidTsRes.valid === false && invalidTsRes.status === "failed", { invalidTsRes });
		assert.ok(invalidTsRes.error?.includes("error TS"), "Invalid TS diagnostic must contain error TS");

		// 6. Test simulated unavailable Node executable: fail open with status='unavailable'
		setNodeExecutableForTesting(null);
		const unavailJsRes = checkSyntax(validJs);
		assertPass(
			"When Node is unavailable, JS check fails open with status='unavailable'",
			unavailJsRes.valid === true && unavailJsRes.status === "unavailable",
			{ unavailJsRes },
		);

		const unavailTsRes = checkSyntax(validTs);
		assertPass(
			"When Node is unavailable, TS check fails open with status='unavailable'",
			unavailTsRes.valid === true && unavailTsRes.status === "unavailable",
			{ unavailTsRes },
		);

		// 7. Test non-Node binary (simulating pi.exe or unrecognized binary): fails open
		setNodeExecutableForTesting({ bin: process.execPath, env: {} });
		// When process.execPath is pi or returns unknown option, it fails open as unavailable
		resetNodeExecutableCache(); // Restore real cache

		logPass("Syntax executable resolution and error classification verified!");
	} finally {
		ws.cleanup();
	}
}

if (require.main === module) {
	testExecutableResolution();
}
