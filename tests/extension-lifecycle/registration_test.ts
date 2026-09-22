import kernelExt from "../../src/index";
import { assertPass, logPass, createTestWorkspace } from "../_setup";

export async function testExtensionRegistration(): Promise<void> {
	const ws = createTestWorkspace("reg_test_");
	const originalPiDir = process.env.PI_DIR;
	process.env.PI_DIR = ws.tempDir;

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
			on(event: string, handler: any) {
				if (!eventHandlers[event]) eventHandlers[event] = [];
				eventHandlers[event].push(handler);
			},
		};

		delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
		kernelExt(mockPi);
		const toolNames = registeredTools.map((t: any) => t.name);
		assertPass("Exact core essential tools (read, edit, code_search) are registered by default",
			toolNames.length === 3 && ["read", "edit", "code_search"].every((n) => toolNames.includes(n)),
			{ toolNames }
		);
		assertPass("Speculative tools are gated by default (Passive Shield)",
			!toolNames.includes("ast_search") && !toolNames.includes("get_repo_map") && !toolNames.includes("lsp"),
			{ toolNames }
		);

		// Test opt-in registration when PI_ENABLE_ALL_RETRIEVAL_TOOLS is active
		const optInTools: any[] = [];
		const mockOptInPi: any = {
			registerTool(tool: any) { optInTools.push(tool); },
			registerCommand() {},
			on() {},
		};
		process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS = "1";
		try {
			kernelExt(mockOptInPi);
			const optInNames = optInTools.map((t: any) => t.name);
			assertPass("Speculative tools registered when opt-in flag enabled",
				["ast_search", "get_repo_map", "lsp"].every((n) => optInNames.includes(n)),
				{ optInNames }
			);
		} finally {
			delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
		}
		assertPass("At least one command is registered", registeredCommands.length > 0, { registeredCommands });
		assertPass("Event handlers are registered (before_agent_start etc.)", Object.keys(eventHandlers).length > 0, { eventHandlers });

		const beforeAgentStart = eventHandlers.before_agent_start?.[0];
		assertPass("before_agent_start handler is registered", typeof beforeAgentStart === "function");
		const result = await beforeAgentStart(
			{
				systemPrompt: "Base system prompt",
				systemPromptOptions: { contextFiles: [] },
			},
			{ cwd: process.cwd(), hasUI: false },
		);
		assertPass(
			"before_agent_start injects kernel guidance",
			typeof result?.systemPrompt === "string" &&
				result.systemPrompt.includes("## Agent Kernel Guidance") &&
				result.systemPrompt.includes("Turn 1 Grounding"),
			{ result },
		);
		const secondResult = await beforeAgentStart(
			{ ...({ systemPrompt: result.systemPrompt, systemPromptOptions: { contextFiles: [] } }) },
			{ cwd: process.cwd(), hasUI: false },
		);
		assertPass(
			"before_agent_start does not duplicate kernel guidance",
			secondResult?.systemPrompt === result.systemPrompt,
			{ result: secondResult },
		);

		const sessionStart = eventHandlers.session_start?.[0];
		assertPass("session_start handler is registered", typeof sessionStart === "function");
		let widgetSetCall: any = null;
		const mockSessionCtx: any = {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				setWidget(key: string, lines: any) {
					widgetSetCall = { key, lines };
				},
				notify() {},
			},
		};
		await sessionStart({}, mockSessionCtx);
		assertPass("session_start completes without unhandled errors", true);

		logPass("Extension registration, guidance injection, and startup indexing verified!");
	} finally {
		if (originalPiDir) {
			process.env.PI_DIR = originalPiDir;
		} else {
			delete process.env.PI_DIR;
		}
		ws.cleanup();
	}
}
