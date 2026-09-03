// Section 24: End-to-End Extension API Lifecycle & Custom Prompt Verification
// Tests the agent-kernel extension's registerTool/registerCommand/on hooks
// and the before_agent_start prompt preservation logic.

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
				assertPass("tool_call write preflight hook registered", !!writePreflight, {
					eventHandlers,
				});
				assertPass("before_agent_start lifecycle hook registered", !!startHandler, {
					eventHandlers,
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
