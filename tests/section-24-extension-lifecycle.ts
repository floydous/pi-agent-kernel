// Section 24: End-to-End Extension API Lifecycle & Custom Prompt Verification
// Tests the agent-kernel extension's registerTool/registerCommand/on hooks
// and the before_agent_start prompt preservation logic.

import * as fs from "node:fs";
import kernelExt from "../src/index";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection(
		"24. End-to-End Extension API Lifecycle & Custom Prompt",
		async () => {
			const ws = createTestWorkspace();
			try {
				const registeredTools: any[] = [];
				const registeredCommands: any[] = [];
				const eventHandlers: Record<string, Function[]> = {};

				const mockPi: any = {
					registerTool(tool: any) {
						registeredTools.push(tool);
					},
					registerCommand(name: string, def: any) {
						registeredCommands.push({ name, def });
					},
					registerProvider(_name: string, _def: any) {},
					on(event: string, handler: Function) {
						if (!eventHandlers[event]) eventHandlers[event] = [];
						eventHandlers[event].push(handler);
					},
					appendEntry(_entry: any) {},
				};

				await kernelExt(mockPi);

				const startHandler = eventHandlers["before_agent_start"]?.[0];
				const writePreflight = eventHandlers["tool_call"]?.[0];
				const resultInterceptor = eventHandlers["tool_result"]?.[0];
				assertPass("tool_call write preflight hook registered", !!writePreflight, {
					eventHandlers,
				});
				assertPass("before_agent_start lifecycle hook registered", !!startHandler, {
					eventHandlers,
				});
				assertPass("tool_result mutation hook registered", !!resultInterceptor, {
					eventHandlers,
				});

				const piDocsCommand = registeredCommands.find((c) => c.name === "pi-docs");
				assertPass("pi-docs command is registered", !!piDocsCommand, {
					registeredCommands,
				});

				const customAgentPrompt =
					"You are a custom AI agent adhering to AGENT.md guidelines.";
				const startResult = await startHandler(
					{ systemPrompt: customAgentPrompt },
					{ cwd: ws.tempDir },
				);

				assertPass(
					"User custom system prompt is preserved in before_agent_start",
					startResult.systemPrompt.includes(customAgentPrompt),
					{ startResult },
				);
				assertPass(
					"Repository AST context is injected into runtime context",
					startResult.systemPrompt.includes("Available Repository Context"),
					{ startResult },
				);
				assertPass(
					"Hardcoded operating instructions are not duplicated into before_agent_start prompt",
					!startResult.systemPrompt.includes("## 1. Honesty, Factual Grounding"),
					{ startResult },
				);
				assertPass(
					"Dedup references are explicitly informational",
					startResult.systemPrompt.includes("It is informational, not an instruction to call recall"),
					{ startResult },
				);

				const sessionContext = {
					cwd: ws.tempDir,
					sessionManager: { getSessionId: () => "lifecycle-docs-test" },
				};
				const docsPrompt = "before\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: docs/README.md\n- Always read pi .md files completely and follow links to related docs (e.g., tui.md for API details)\nafter";
				const docsOn = await startHandler({ systemPrompt: docsPrompt }, sessionContext);
				assertPass("Pi documentation guidance is enabled by default", docsOn.systemPrompt.includes("Pi documentation (read only"), {
					docsOn,
				});
				await piDocsCommand.def.handler("off", sessionContext);
				const docsOff = await startHandler({ systemPrompt: docsPrompt }, sessionContext);
				assertPass("pi-docs off removes only Pi documentation guidance", !docsOff.systemPrompt.includes("Pi documentation (read only") && docsOff.systemPrompt.includes("Available Repository Context"), {
					docsOff,
				});
				await piDocsCommand.def.handler("on", sessionContext);
				const docsRestored = await startHandler({ systemPrompt: docsPrompt }, sessionContext);
				assertPass("pi-docs on restores Pi documentation guidance", docsRestored.systemPrompt.includes("Pi documentation (read only"), {
					docsRestored,
				});

				const blockedWrite = await writePreflight(
					{ toolName: "write", input: { path: "calculator.py" } },
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);
				assertPass("Blocked write does not request batch termination", blockedWrite?.terminate !== true, {
					blockedWrite,
				});
				const followUp = await writePreflight(
					{ toolName: "read", input: { path: "calculator.py" } },
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);
				assertPass("Write rejection leaves the preflight hook able to process follow-up events", followUp === undefined, {
					followUp,
				});
				logPass(
					"End-to-end user prompt preservation & dynamic runtime context injection verified!",
				);

				// Verify core agent kernel tools are registered
				const expectedTools = [
					"get_repo_map",
					"recall",
					"ast_search",
					"code_search",
					"read",
					"lsp",
					"edit",
				];
				for (const toolName of expectedTools) {
					const found = registeredTools.find((t) => t.name === toolName);
					assertPass(`Core kernel tool '${toolName}' is registered`, !!found, {
						registeredTools,
					});
				}
				logPass(`Core kernel tools verified (${expectedTools.join(", ")})!`);

				// Test the write tool interception and search index invalidation path
				const testFile = `${ws.tempDir}/host_write_test.ts`;
				fs.writeFileSync(testFile, "export const marker = 'initialHostWrite';\n", "utf8");
				const searchTool = registeredTools.find((t) => t.name === "code_search");
				assertPass("code_search tool registered", !!searchTool, { searchTool });

				// Direct execution of code_search initially finds initialHostWrite
				const initialHits = await searchTool.execute(
					"call-search-1",
					{ query: "initialHostWrite", limit: 5 },
					undefined,
					() => {},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);
				assertPass(
					"Initial search hit resolves newly indexed file",
					initialHits?.content?.[0]?.text?.includes("initialHostWrite"),
					{ initialHits },
				);

				// Now simulate a host write modifying the file, followed by the tool_result hook
				fs.writeFileSync(testFile, "export const marker = 'updatedHostWrite';\n", "utf8");
				await resultInterceptor(
					{
						toolName: "write",
						input: { path: "host_write_test.ts" },
						content: [{ type: "text", text: "Successfully wrote to host_write_test.ts" }],
					},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);

				// Subsequent search query should immediately discover the updated content
				const updatedHits = await searchTool.execute(
					"call-search-2",
					{ query: "updatedHostWrite", limit: 5 },
					undefined,
					() => {},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);
				assertPass(
					"Search refreshes without explicit reindex after host write hook execution",
					updatedHits?.content?.[0]?.text?.includes("updatedHostWrite"),
					{ updatedHits },
				);
				logPass("Host write tool result invalidation & automatic search refresh verified!");

				// Verify registered custom edit tool invalidation & epistemic authorization
				const editTool = registeredTools.find((t) => t.name === "edit");
				assertPass("edit tool registered", !!editTool, { editTool });
				const readTool = registeredTools.find((t) => t.name === "read");
				assertPass("read tool registered", !!readTool, { readTool });

				// Read file to satisfy the epistemic guard
				const readRes = await readTool.execute(
					"call-read-1",
					{ path: "host_write_test.ts" },
					undefined,
					() => {},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);
				assertPass("read executed successfully", !readRes?.isError, { readRes });

				// Execute surgical edit
				const editRes = await editTool.execute(
					"call-edit-1",
					{
						path: "host_write_test.ts",
						search: "updatedHostWrite",
						replace: "editedViaCustomTool",
					},
					undefined,
					() => {},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);
				assertPass("edit executed successfully", !editRes?.isError, { editRes });

				// Search query should discover the edit immediately
				const afterEditHits = await searchTool.execute(
					"call-search-3",
					{ query: "editedViaCustomTool", limit: 5 },
					undefined,
					() => {},
					{ cwd: ws.tempDir, sessionManager: { getSessionId: () => "lifecycle-test" } },
				);
				assertPass(
					"Search discovers custom edit tool changes without manual reindex",
					afterEditHits?.content?.[0]?.text?.includes("editedViaCustomTool"),
					{ afterEditHits },
				);
				logPass("Custom edit tool mutation & search invalidation flow verified!");
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
