import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerEditTool } from "../../src/tools/edit_tool";
import { registerReadTool } from "../../src/tools/read_tool";

export async function run(): Promise<void> {
	console.log("=== Running Line Span Confirmation (Option 1A) Test Suite ===");

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-line-span-test-"));
	const testFile = path.join(tempDir, "sample.js");

	let readTool: any;
	let editTool: any;
	const mockPi = {
		registerTool(t: any) {
			if (t.name === "read") readTool = t;
			if (t.name === "edit") editTool = t;
		},
	};

	registerReadTool(mockPi as any, {
		getSessionId: () => "span-session",
		getConfig: () => ({ editing: { mode: "smart_anchor" }, safety: { max_total_bytes: 20 * 1024 } }) as any,
	});
	registerEditTool(mockPi as any, {
		getSessionId: () => "span-session",
		getConfig: () => ({ editing: { mode: "smart_anchor" }, safety: { max_total_bytes: 20 * 1024 } }) as any,
	});

	const mockCtx = { cwd: tempDir };

	try {
		// 1. Single line replaced with single line (line 2 -> line 2)
		console.log("1. Testing 1-to-1 replacement line span summary...");
		fs.writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
		await readTool.execute("r1", { path: "sample.js" }, null, () => {}, mockCtx);

		const res1 = await editTool.execute("e1", {
			path: "sample.js",
			search: "const b = 2;",
			replace: "const b = 20;",
		}, null, () => {}, mockCtx);

		assert.ok(!res1.isError);
		assert.match(res1.content[0].text, /Successfully applied edit to sample\.js \(line 2 -> line 2\)\./);

		// 2. Multi-line replaced with single line (lines 2-4 -> line 2)
		console.log("2. Testing N-to-1 replacement line span summary...");
		fs.writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n", "utf8");
		await readTool.execute("r2", { path: "sample.js" }, null, () => {}, mockCtx);

		const res2 = await editTool.execute("e2", {
			path: "sample.js",
			search: "const b = 2;\nconst c = 3;\nconst d = 4;",
			replace: "const bcd = 234;",
		}, null, () => {}, mockCtx);

		assert.ok(!res2.isError);
		assert.match(res2.content[0].text, /Successfully applied edit to sample\.js \(lines 2–4 -> line 2\)\./);

		// 3. Single line replaced with multi-line (line 2 -> 2-4)
		console.log("3. Testing 1-to-N replacement line span summary...");
		fs.writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
		await readTool.execute("r3", { path: "sample.js" }, null, () => {}, mockCtx);

		const res3 = await editTool.execute("e3", {
			path: "sample.js",
			search: "const b = 2;",
			replace: "const b1 = 21;\nconst b2 = 22;\nconst b3 = 23;",
		}, null, () => {}, mockCtx);

		assert.ok(!res3.isError);
		assert.match(res3.content[0].text, /Successfully applied edit to sample\.js \(line 2 -> 2–4\)\./);

		// 4. Deletion of lines (lines 2-3 deleted)
		console.log("4. Testing deletion line span summary...");
		fs.writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n", "utf8");
		await readTool.execute("r4", { path: "sample.js" }, null, () => {}, mockCtx);

		const res4 = await editTool.execute("e4", {
			path: "sample.js",
			search: "const b = 2;\nconst c = 3;\n",
			replace: "",
		}, null, () => {}, mockCtx);

		assert.ok(!res4.isError);
		assert.match(res4.content[0].text, /Successfully applied edit to sample\.js \(lines 2–3 deleted\)\./);

		console.log("\n✓ All Line Span Confirmation Tests Passed Successfully!");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	run().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
