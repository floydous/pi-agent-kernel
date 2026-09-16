import kernelExt from "../../src/index";
import { assertPass, logPass } from "../_setup";

export async function testExtensionRegistration(): Promise<void> {
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

	kernelExt(mockPi);
	const toolNames = registeredTools.map((t: any) => t.name);
	assertPass("Core essential tools (read, edit) are always registered",
		["read", "edit"].every((n) => toolNames.includes(n)),
		{ toolNames }
	);
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
}
