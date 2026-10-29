import * as assert from "node:assert/strict";
import * as path from "node:path";
import kernelExt from "../../src/index";
import { markReturnedErrors } from "../../src/tools/context";
import { createTestWorkspace, logPass } from "../_setup";

// pi sets a tool result's error flag only when execute throws. Kernel tools return failures, so the flag travels in
// details.isError and the kernel's tool_result hook turns it back into isError.
export async function run(): Promise<void> {
	const ok = { content: [{ type: "text", text: "fine" }], details: { strategy: "exact" } };
	const wrapped = markReturnedErrors({
		name: "t",
		async execute(_id: string, params: any) {
			return params.fail ? { content: [{ type: "text", text: "[EDIT FAILED] x" }], details: { rolledBack: true }, isError: true } : ok;
		},
	});
	assert.equal(await wrapped.execute("1", {}), ok, "successful results pass through unchanged");
	assert.deepEqual((await wrapped.execute("2", { fail: true })).details, { rolledBack: true, isError: true });

	const ws = createTestWorkspace("tool_error_flag_");
	const originalPiDir = process.env.PI_DIR;
	process.env.PI_DIR = ws.tempDir;
	try {
		const tools: any[] = [];
		const handlers: Record<string, Function[]> = {};
		const mockPi: any = {
			registerTool(tool: any) { tools.push(tool); },
			registerCommand() {},
			getAllTools() {
				return tools.map((tool) => ({ name: tool.name, parameters: tool.parameters, sourceInfo: { path: "/mock/kernel.ts" } }));
			},
			getActiveTools() { return [...tools.map((tool) => tool.name), "bash"]; },
			on(event: string, handler: Function) {
				(handlers[event] ??= []).push(handler);
				return () => {};
			},
		};
		await kernelExt(mockPi);
		const ctx: any = {
			cwd: ws.tempDir,
			hasUI: false,
			isProjectTrusted: () => false,
			ui: { notify() {} },
			sessionManager: { getCwd: () => ws.tempDir },
		};
		await handlers.session_start[0]({}, ctx);
		const edit = tools.find((tool) => tool.name === "edit");
		const onResult = handlers.tool_result[0];

		const failed = await edit.execute("e1", { path: "missing.ts", search: "a", replace: "b" }, undefined, undefined, ctx);
		assert.equal(failed.details?.isError, true);
		const event = (toolName: string, result: any) => ({
			type: "tool_result", toolName, toolCallId: "c", input: {}, content: result.content, details: result.details, isError: false,
		});
		assert.deepEqual(await onResult(event("edit", failed), ctx), { isError: true }, "a kernel tool failure becomes an error result");
		assert.notEqual((await onResult(event("edit", ok), ctx))?.isError, true, "a success stays a success");
		assert.notEqual(
			(await onResult(event("other_extension_tool", failed), ctx))?.isError,
			true,
			"only kernel tools are re-flagged",
		);
		logPass(`Tool failures reach pi as errors (${path.basename(ws.tempDir)})`);
	} finally {
		if (originalPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = originalPiDir;
		ws.cleanup();
	}
}
