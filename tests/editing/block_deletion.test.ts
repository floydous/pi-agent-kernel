import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerEditTool } from "../../src/tools/edit_tool";
import { registerReadTool } from "../../src/tools/read_tool";

export async function run(): Promise<void> {
	console.log("=== Running Block Deletion with replace: \"\" Test Suite ===");

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-block-del-test-"));
	const testFile = path.join(tempDir, "manifest.json");

	let readTool: any;
	let editTool: any;
	const mockPi = {
		registerTool(t: any) {
			if (t.name === "read") readTool = t;
			if (t.name === "edit") editTool = t;
		},
	};

	registerReadTool(mockPi as any, {
		getSessionId: () => "del-session",
		getConfig: () => ({ editing: { mode: "smart_anchor" }, safety: { max_total_bytes: 20 * 1024 } }) as any,
	});
	registerEditTool(mockPi as any, {
		getSessionId: () => "del-session",
		getConfig: () => ({ editing: { mode: "smart_anchor" }, safety: { max_total_bytes: 20 * 1024 } }) as any,
	});

	const mockCtx = { cwd: tempDir };

	try {
		// 1. Whole-line block deletion with replace: "" (without trailing \n in search)
		console.log("1. Testing whole-line block deletion with replace: \"\"...");
		const jsonInitial = [
			"{",
			'  "name": "edge-unbound",',
			'  "content_scripts": [',
			'    "hook.js"',
			"  ],",
			'  "version": "1.0"',
			"}",
		].join("\n") + "\n";
		fs.writeFileSync(testFile, jsonInitial, "utf8");

		// Read first to satisfy epistemic guard
		await readTool.execute("r1", { path: "manifest.json" }, null, () => {}, mockCtx);

		// Delete content_scripts block using replace: "" without trailing \n in search
		const searchBlock = '  "content_scripts": [\n    "hook.js"\n  ],';
		const delRes1 = await editTool.execute("e1", {
			path: "manifest.json",
			search: searchBlock,
			replace: "",
		}, null, () => {}, mockCtx);

		assert.ok(!delRes1.isError, `Deletion must succeed: ${delRes1.content?.[0]?.text}`);
		const contentAfter1 = fs.readFileSync(testFile, "utf8");
		const expected1 = [
			"{",
			'  "name": "edge-unbound",',
			'  "version": "1.0"',
			"}",
		].join("\n") + "\n";
		assert.equal(contentAfter1, expected1, "Whole-line deletion must leave zero blank lines between keys");

		// 2. Inline substring deletion with replace: ""
		console.log("2. Testing inline substring deletion with replace: \"\"...");
		const codeFile = path.join(tempDir, "script.js");
		fs.writeFileSync(codeFile, "function execute(task, unusedArg, timeout) {}\n", "utf8");
		await readTool.execute("r2", { path: "script.js" }, null, () => {}, mockCtx);

		const delRes2 = await editTool.execute("e2", {
			path: "script.js",
			search: ", unusedArg",
			replace: "",
		}, null, () => {}, mockCtx);

		assert.ok(!delRes2.isError, `Inline deletion must succeed: ${delRes2.content?.[0]?.text}`);
		const contentAfter2 = fs.readFileSync(codeFile, "utf8");
		assert.equal(
			contentAfter2,
			"function execute(task, timeout) {}\n",
			"Inline deletion must not remove line or line break",
		);

		// 3. Deletion via replace: null (gateway coercion)
		console.log("3. Testing deletion via replace: null...");
		fs.writeFileSync(codeFile, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
		await readTool.execute("r3", { path: "script.js" }, null, () => {}, mockCtx);

		const delRes3 = await editTool.execute("e3", {
			path: "script.js",
			search: "const b = 2;\n",
			replace: null,
		}, null, () => {}, mockCtx);

		assert.ok(!delRes3.isError, `replace: null must succeed as deletion: ${delRes3.content?.[0]?.text}`);
		assert.equal(fs.readFileSync(codeFile, "utf8"), "const a = 1;\nconst c = 3;\n");

		// 4. Nested deletion in edits[] with replace: ""
		console.log("4. Testing nested deletion in edits[] with replace: \"\"...");
		fs.writeFileSync(codeFile, "alpha\nbeta\ngamma\n", "utf8");
		await readTool.execute("r4", { path: "script.js" }, null, () => {}, mockCtx);

		const delRes4 = await editTool.execute("e4", {
			path: "script.js",
			edits: [{ search: "beta\n", replace: "" }],
		}, null, () => {}, mockCtx);

		assert.ok(!delRes4.isError);
		assert.equal(fs.readFileSync(codeFile, "utf8"), "alpha\ngamma\n");

		// 5. Bare { path, search } without replace fails closed safely
		console.log("5. Testing bare search without replace fails closed safely...");
		const bareSearchRes = await editTool.execute("e5", {
			path: "script.js",
			search: "alpha",
		}, null, () => {}, mockCtx);

		assert.equal(bareSearchRes.isError, true, "Must fail closed when replace is missing");
		assert.match(bareSearchRes.content[0].text, /Missing 'replace'/);
		assert.match(bareSearchRes.content[0].text, /replace: ""/);

		// 6. Whitespace-normalized deletion cleanly removes lines
		console.log("6. Testing whitespace-normalized deletion cleanly removes lines...");
		fs.writeFileSync(
			codeFile,
			"function test() {\n    if (obsolete) {\n        cleanup();\n    }\n    return 42;\n}\n",
			"utf8",
		);
		await readTool.execute("r6", { path: "script.js" }, null, () => {}, mockCtx);

		const searchBlock6 = "  if (obsolete) {\n      cleanup();\n  }";
		const delRes6 = await editTool.execute("e6", {
			path: "script.js",
			search: searchBlock6,
			replace: "",
		}, null, () => {}, mockCtx);

		assert.ok(!delRes6.isError, `Whitespace-normalized deletion must succeed: ${delRes6.content?.[0]?.text}`);
		assert.equal(delRes6.details?.strategy, "whitespace_normalized");
		const contentAfter6 = fs.readFileSync(codeFile, "utf8");
		assert.equal(
			contentAfter6,
			"function test() {\n    return 42;\n}\n",
			"Whitespace-normalized deletion must remove the block without leaving an empty line",
		);

		// 7. prepareArguments normalizes top-level blocks, aliases, stringified edits, replace: null, and keeps missing replace fail-closed
		console.log("7. Testing prepareArguments canonicalizes default shapes and keeps missing replace fail-closed...");
		const prepSingle = editTool.prepareArguments({ path: "script.js", search: "x", replace: null });
		assert.deepEqual(prepSingle.edits, [{ search: "x", replace: "" }]);
		assert.equal(prepSingle.search, undefined);
		assert.equal(prepSingle.replace, undefined);

		const prepNested = editTool.prepareArguments({
			files: [{ path: "script.js", search: "y", replace: null }],
		});
		assert.deepEqual(prepNested.files[0].edits, [{ search: "y", replace: "" }]);

		const prepAlias = editTool.prepareArguments({
			path: "script.js",
			edits: [{ oldText: "x", newText: "" }],
		});
		assert.deepEqual(prepAlias.edits, [{ search: "x", replace: "" }]);

		const prepStringified = editTool.prepareArguments({
			path: "script.js",
			edits: '[{"search":"x","replace":""}]',
		});
		assert.deepEqual(prepStringified.edits, [{ search: "x", replace: "" }]);

		const prepMissingReplace = editTool.prepareArguments({ path: "script.js", search: "x" });
		assert.equal(prepMissingReplace.replace, undefined);
		assert.equal(prepMissingReplace.edits, undefined);

		const prepEditsWithPath = editTool.prepareArguments({
			edits: [{ path: "script.js", search: "x", replace: "y" }],
		});
		assert.deepEqual(prepEditsWithPath.files, [{ path: "script.js", edits: [{ search: "x", replace: "y" }] }]);
		assert.equal(prepEditsWithPath.edits, undefined);

		console.log("\n✓ All Block Deletion Tests Passed Successfully!");
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
