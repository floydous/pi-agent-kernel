// Section 33: Epistemic Guard Mutation Continuity & Interference Defense

import * as fs from "fs";
import * as path from "path";
import { EpistemicGuard } from "../src/safety/epistemic_guard";
import { applySurgicalPatch } from "../src/editing/patch";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";
import kernelExt from "../src/index";

async function main(): Promise<void> {
	await runSection(
		"33. Epistemic Guard Mutation Continuity & Interference Defense",
		async () => {
			const ws = createTestWorkspace();
			const guard = new EpistemicGuard();
			const TEST_SESSION = "__test_session_33__";

			try {
				// 1. Test Sequential Edits Without Intervening Read
				const seqPath = path.join(ws.tempDir, "sequential.py");
				const initialSeq = `import sys

def calculate_fee(amount: float) -> float:
    return amount * 0.05

def calculate_total(amount: float) -> float:
    return amount + calculate_fee(amount)
`;
				fs.writeFileSync(seqPath, initialSeq, "utf8");

				// Initial complete read
				guard.recordFileRead(seqPath, TEST_SESSION, ws.tempDir, initialSeq, {
					coverage: { complete: true, ranges: [{ startLine: 1, endLine: 8 }] },
					provenance: "read",
				});

				// Edit 1: update imports
				const check1 = guard.checkReadPrecondition(
					seqPath,
					"edit",
					TEST_SESSION,
					ws.tempDir,
					true,
					[{ startLine: 1, endLine: 1 }],
				);
				assertPass("Turn 1 edit allowed by epistemic guard", check1.allowed, { check1 });

				const patch1 = applySurgicalPatch(
					seqPath,
					"import sys\n",
					"import sys\nimport os\n",
				);
				assertPass("Turn 1 patch applied successfully", patch1.success, { patch1 });

				// Record mutation
				const postEdit1Content = fs.readFileSync(seqPath, "utf8");
				guard.recordFileMutation(
					seqPath,
					TEST_SESSION,
					ws.tempDir,
					postEdit1Content,
					{ complete: true },
				);

				// Edit 2: immediately edit calculate_total without an intervening read call
				const check2 = guard.checkReadPrecondition(
					seqPath,
					"edit",
					TEST_SESSION,
					ws.tempDir,
					true,
					[{ startLine: 7, endLine: 8 }],
				);
				assertPass(
					"Turn 2 sequential edit allowed without redundant read",
					check2.allowed,
					{ check2 },
				);

				const patch2 = applySurgicalPatch(
					seqPath,
					"def calculate_total(amount: float) -> float:\n    return amount + calculate_fee(amount)",
					"def calculate_total(amount: float) -> float:\n    return round(amount + calculate_fee(amount), 2)",
				);
				assertPass("Turn 2 patch applied successfully", patch2.success, { patch2 });
				logPass("Sequential edits continuity verified without redundant reads!");

				// 2. Test External Interference / Drift Detection
				// Simulate an external tool, git pull, or linter editing the file behind the agent's back
				fs.writeFileSync(
					seqPath,
					"# external modification\n" + fs.readFileSync(seqPath, "utf8"),
					"utf8",
				);
				const checkDrift = guard.checkReadPrecondition(
					seqPath,
					"edit",
					TEST_SESSION,
					ws.tempDir,
					true,
					[{ startLine: 1, endLine: 2 }],
				);
				assertPass(
					"External modification is caught and blocked by epistemic guard",
					!checkDrift.allowed && checkDrift.reason?.includes("File changed since read") === true,
					{ checkDrift },
				);
				logPass("External file drift protection preserved!");

				// 3. Test Partial-Read Coordinate Shifting & Blind Edit Rejection
				const partialPath = path.join(ws.tempDir, "partial.py");
				const partialLines: string[] = [];
				for (let i = 1; i <= 50; i++) {
					partialLines.push(`val_${i} = ${i}`);
				}
				fs.writeFileSync(partialPath, partialLines.join("\n") + "\n", "utf8");

				// Record partial read covering only lines 1-20
				guard.recordFileRead(partialPath, TEST_SESSION, ws.tempDir, undefined, {
					coverage: { complete: false, ranges: [{ startLine: 1, endLine: 20 }], totalLines: 50 },
					provenance: "read",
				});

				// Edit at line 1 adding 5 new lines
				const editPartial1 = applySurgicalPatch(
					partialPath,
					"val_1 = 1\n",
					"val_1 = 1\n# extra 1\n# extra 2\n# extra 3\n# extra 4\n# extra 5\n",
				);
				assertPass("Partial file patch 1 applied", editPartial1.success, { editPartial1 });

				const postPartialContent = fs.readFileSync(partialPath, "utf8");
				guard.recordFileMutation(
					partialPath,
					TEST_SESSION,
					ws.tempDir,
					postPartialContent,
					{
						complete: false,
						targetRanges: [{ startLine: 1, endLine: 1 }],
						deltaLines: 5,
					},
				);

				// Blind edit at line 40 (never read) must be rejected
				const checkBlind = guard.checkReadPrecondition(
					partialPath,
					"edit",
					TEST_SESSION,
					ws.tempDir,
					true,
					[{ startLine: 40, endLine: 40 }],
				);
				assertPass(
					"Blind edit outside coverage remains strictly blocked",
					!checkBlind.allowed && checkBlind.reason?.includes("Target lines not covered") === true,
					{ checkBlind },
				);

				// Edit at line 15 (shifted by +5 to line 20, still within shifted coverage 1-25)
				const checkShifted = guard.checkReadPrecondition(
					partialPath,
					"edit",
					TEST_SESSION,
					ws.tempDir,
					true,
					[{ startLine: 20, endLine: 20 }],
				);
				assertPass(
					"Edit within shifted partial coverage range is authorized",
					checkShifted.allowed,
					{ checkShifted },
				);
				logPass("Partial-read coordinate shifting and blind edit defense verified!");

				// 4. End-to-End Test with Kernel Extension: Host Write Authorizes Subsequent Edit
				const registeredTools: any[] = [];
				const eventHandlers: Record<string, Function[]> = {};
				const mockPi: any = {
					registerTool(t: any) { registeredTools.push(t); },
					registerCommand() {},
					registerProvider() {},
					on(event: string, handler: Function) {
						if (!eventHandlers[event]) eventHandlers[event] = [];
						eventHandlers[event].push(handler);
					},
					appendEntry() {},
				};
				await kernelExt(mockPi);

				const resultInterceptor = eventHandlers["tool_result"]?.[0];
				const e2eFilePath = path.join(ws.tempDir, "e2e_module.py");
				fs.writeFileSync(e2eFilePath, "def initial_func():\n    return 100\n", "utf8");

				// Simulate host write tool result
				await resultInterceptor(
					{
						toolName: "write",
						input: { path: "e2e_module.py" },
						content: [{ type: "text", text: "Successfully wrote to e2e_module.py" }],
					},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "e2e-session-33" } },
				);

				// Immediately perform custom edit tool call without reading first
				const editTool = registeredTools.find((t) => t.name === "edit");
				const editRes = await editTool.execute(
					"call-edit-e2e",
					{
						path: "e2e_module.py",
						search: "def initial_func():\n    return 100\n",
						replace: "def initial_func():\n    return 200\n",
					},
					undefined,
					() => {},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "e2e-session-33" } },
				);
				assertPass(
					"Host write immediately authorizes subsequent edit without manual read",
					!editRes?.isError,
					{ editRes },
				);

				// Execute a second sequential edit on the same file
				const editRes2 = await editTool.execute(
					"call-edit-e2e-2",
					{
						path: "e2e_module.py",
						search: "return 200",
						replace: "return 300",
					},
					undefined,
					() => {},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "e2e-session-33" } },
				);
				assertPass(
					"Second sequential edit succeeds without manual read",
					!editRes2?.isError,
					{ editRes2 },
				);
				assertPass(
					"Final file reflects both sequential edits",
					fs.readFileSync(e2eFilePath, "utf8").includes("return 300"),
					{ content: fs.readFileSync(e2eFilePath, "utf8") },
				);
				logPass("End-to-end host write + sequential edit continuity verified!");
			} finally {
				ws.cleanup();
			}
		},
	);
}

main().catch((err) => {
	console.error(err);
	throw err;
});
