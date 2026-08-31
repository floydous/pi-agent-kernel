// Section 24: End-to-End Extension API Lifecycle & Custom Prompt Verification
// Tests the agent-kernel extension's registerTool/registerCommand/on hooks
// and the before_agent_start prompt preservation logic.

import kernelExt from "../src/index";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("24. End-to-End Extension API Lifecycle & Custom Prompt", async () => {
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
				registerProvider(name: string, def: any) {},
				on(event: string, handler: Function) {
					if (!eventHandlers[event]) eventHandlers[event] = [];
					eventHandlers[event].push(handler);
				},
				appendEntry(_entry: any) {},
			};

			await kernelExt(mockPi);

			const startHandler = eventHandlers["before_agent_start"]?.[0];
			assertPass("before_agent_start lifecycle hook registered", !!startHandler, { eventHandlers });

			const customAgentPrompt = "You are a custom AI agent adhering to AGENT.md guidelines.";
			const startResult = await startHandler({ systemPrompt: customAgentPrompt }, { cwd: ws.tempDir });

			assertPass(
				"User custom system prompt is preserved in before_agent_start",
				startResult.systemPrompt.includes(customAgentPrompt),
				{ startResult }
			);
			assertPass(
				"Repository AST context is injected into runtime context",
				startResult.systemPrompt.includes("Available Repository Context"),
				{ startResult }
			);
			assertPass(
				"Hardcoded operating instructions are not duplicated into before_agent_start prompt",
				!startResult.systemPrompt.includes("## 1. Honesty, Factual Grounding"),
				{ startResult }
			);
			logPass("End-to-end user prompt preservation & dynamic runtime context injection verified!");

			// Verify core agent kernel tools are registered
			const expectedTools = ["get_repo_map", "ast_search", "code_search", "read", "lsp", "edit"];
			for (const toolName of expectedTools) {
				const found = registeredTools.find((t) => t.name === toolName);
				assertPass(`Core kernel tool '${toolName}' is registered`, !!found, { registeredTools });
			}
			logPass(`Core kernel tools verified (${expectedTools.join(", ")})!`);
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
