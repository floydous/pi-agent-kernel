import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerReadTool } from "../../src/tools/read_tool";
import { registerEditTool } from "../../src/tools/edit_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";

export async function run(): Promise<void> {
	console.log("=== Running Tool Confusion Recovery Unit & Boundary Tests ===");

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-confusion-test-"));
	const testFile = path.join(tempDir, "sample.txt");
	fs.writeFileSync(testFile, "Hello World\nLine 2\nLine 3\n", "utf8");

	let readToolDef: any = null;
	let editToolDef: any = null;

	const mockPi: any = {
		registerTool: (tool: any) => {
			if (tool.name === "read") readToolDef = tool;
			if (tool.name === "edit") editToolDef = tool;
		},
	};

	const deps: any = {
		getSessionId: () => "session-test-confusion",
		getConfig: () => ({ editing: { mode: "smart_anchor" }, safety: { max_total_bytes: 20480 } }),
	};

	registerReadTool(mockPi, deps);
	registerEditTool(mockPi, deps);

	assert.ok(readToolDef, "read tool must be registered");
	assert.ok(editToolDef, "edit tool must be registered");

	const mockCtx = { cwd: tempDir };

	// 1. Read tool with shell command
	console.log("1. Testing read tool when passed shell command payload...");
	const readConfusionRes = await readToolDef.execute(
		"call-1",
		{ command: "sed -n '175,230p' test.js; sed -n '350,390p' test.js" },
		undefined,
		undefined,
		mockCtx,
	);

	assert.equal(readConfusionRes.isError, true, "Read tool must fail on tool confusion");
	assert.ok(
		readConfusionRes.content[0].text.includes("Received shell command in 'read' tool"),
		"Read tool must explicitly explain tool confusion",
	);
	assert.ok(
		readConfusionRes.content[0].text.includes("invoke the 'bash' tool instead"),
		"Read tool must direct caller to the 'bash' tool",
	);
	assert.equal(
		readConfusionRes.details?.error,
		"tool_confusion_command",
		"Read tool must include machine-readable error detail",
	);

	// 2. Read tool with ambiguous payload (both command and path)
	console.log("2. Testing read tool with ambiguous parameters (command + path)...");
	const readAmbiguousRes = await readToolDef.execute(
		"call-2",
		{ command: "echo test", path: "sample.txt" },
		undefined,
		undefined,
		mockCtx,
	);
	assert.equal(readAmbiguousRes.isError, true, "Read tool must reject ambiguous payload");
	assert.ok(
		readAmbiguousRes.content[0].text.includes("Ambiguous parameters"),
		"Read tool must explain ambiguous parameters",
	);
	assert.equal(readAmbiguousRes.details?.error, "ambiguous_parameters");

	// 3. Edit tool with shell command
	console.log("3. Testing edit tool when passed shell command payload...");
	const editConfusionRes = await editToolDef.execute(
		"call-3",
		{ command: "npx ava test/retry.ts -m '*extending a numeric*'", timeout: 120000 },
		undefined,
		undefined,
		mockCtx,
	);
	assert.equal(editConfusionRes.isError, true, "Edit tool must fail on tool confusion");
	assert.ok(
		editConfusionRes.content[0].text.includes("Received shell command in 'edit' tool"),
		"Edit tool must explicitly explain tool confusion",
	);
	assert.ok(
		editConfusionRes.content[0].text.includes("invoke the 'bash' tool instead"),
		"Edit tool must direct caller to the 'bash' tool",
	);
	assert.equal(
		editConfusionRes.details?.error,
		"tool_confusion_command",
		"Edit tool must include machine-readable error detail",
	);

	// 4. Edit tool with ambiguous payload (both command and path)
	console.log("4. Testing edit tool with ambiguous parameters (command + path)...");
	const editAmbiguousRes = await editToolDef.execute(
		"call-4",
		{ command: "npm test", path: "sample.txt", search: "Hello World", replace: "Hello Test" },
		undefined,
		undefined,
		mockCtx,
	);
	assert.equal(editAmbiguousRes.isError, true, "Edit tool must reject ambiguous payload");
	assert.ok(
		editAmbiguousRes.content[0].text.includes("Ambiguous parameters"),
		"Edit tool must explain ambiguous parameters",
	);
	assert.equal(editAmbiguousRes.details?.error, "ambiguous_parameters");

	// 5. Verify file was NOT modified and epistemic ledger has NO phantom entries
	assert.equal(
		fs.readFileSync(testFile, "utf8"),
		"Hello World\nLine 2\nLine 3\n",
		"File contents must remain unmodified",
	);
	const evidence = globalEpistemicGuard.getEvidence(testFile, "session-test-confusion", tempDir);
	assert.equal(evidence, null, "No epistemic evidence should be granted for confused/ambiguous calls");

	// 6. Non-string command edge cases fall back to standard validation
	console.log("5. Testing non-string and whitespace-only command fallbacks...");
	const readNumberCmd = await readToolDef.execute(
		"call-5",
		{ command: 12345 },
		undefined,
		undefined,
		mockCtx,
	);
	assert.equal(readNumberCmd.isError, true);
	assert.ok(
		readNumberCmd.content[0].text.includes("Missing required 'path' or 'paths' parameter"),
		"Non-string command must fall back to normal missing required parameter error",
	);

	const editWhitespaceCmd = await editToolDef.execute(
		"call-6",
		{ command: "    " },
		undefined,
		undefined,
		mockCtx,
	);
	assert.equal(editWhitespaceCmd.isError, true);
	assert.ok(
		editWhitespaceCmd.content[0].text.includes("Missing required 'path' parameter"),
		"Whitespace command must fall back to normal missing required parameter error",
	);

	// 7. Search without replace (agent intends deletion) names the missing key and the deletion form
	console.log("6. Testing edit with 'search' but no 'replace'...");
	const missingReplaceRes = await editToolDef.execute(
		"call-7",
		{ path: "sample.txt", search: "Line 2\n" },
		undefined,
		undefined,
		mockCtx,
	);
	assert.equal(missingReplaceRes.isError, true);
	assert.ok(
		missingReplaceRes.content[0].text.includes("Missing 'replace'"),
		`Must name the missing 'replace' key, got: ${missingReplaceRes.content[0].text}`,
	);
	assert.ok(
		missingReplaceRes.content[0].text.includes(`edits: [{ search: "<block>", replace: "" }]`),
		"Must steer deletions to the nested edits[] form, which keeps an empty 'replace' intact",
	);

	// 8. Read-shaped arguments sent to edit point the caller to 'read'
	console.log("7. Testing edit with read-shaped offset/limit arguments...");
	const readShapedRes = await editToolDef.execute(
		"call-8",
		{ path: "sample.txt", offset: 2, limit: 1 },
		undefined,
		undefined,
		mockCtx,
	);
	assert.equal(readShapedRes.isError, true);
	assert.ok(
		readShapedRes.content[0].text.includes("'offset'/'limit' are 'read' arguments"),
		`Must identify read-shaped arguments, got: ${readShapedRes.content[0].text}`,
	);
	assert.equal(fs.readFileSync(testFile, "utf8"), "Hello World\nLine 2\nLine 3\n", "Rejected edits must not modify the file");

	// 9. The suggested deletion form works: edits: [{ search, replace: "" }] removes the block after a read
	console.log("8. Testing that edits: [{ search, replace: \"\" }] deletes the matched block...");
	await readToolDef.execute("call-9", { path: "sample.txt" }, undefined, undefined, mockCtx);
	const deleteRes = await editToolDef.execute(
		"call-10",
		{ path: "sample.txt", edits: [{ search: "Line 2\n", replace: "" }] },
		undefined,
		undefined,
		mockCtx,
	);
	assert.notEqual(deleteRes.isError, true, `Deletion edit must succeed, got: ${deleteRes.content?.[0]?.text}`);
	assert.equal(fs.readFileSync(testFile, "utf8"), "Hello World\nLine 3\n", "edits[] with replace: \"\" must delete the matched block");

	// Cleanup
	fs.rmSync(tempDir, { recursive: true, force: true });
	console.log("✓ All tool confusion recovery unit & boundary tests passed successfully!");
}
