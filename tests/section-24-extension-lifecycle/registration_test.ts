import kernelExt from "../../src/index";
import { assertPass, logPass } from "../_setup";

export function testExtensionRegistration(): void {
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
	assertPass("Core kernel tools (get_repo_map, recall, ast_search, code_search, read, lsp, edit) are registered",
		["get_repo_map", "recall", "ast_search", "code_search", "read", "lsp", "edit"].every((n) => toolNames.includes(n)),
		{ toolNames }
	);
	assertPass("At least one command is registered", registeredCommands.length > 0, { registeredCommands });
	assertPass("Event handlers are registered (before_agent_start etc.)", Object.keys(eventHandlers).length > 0, { eventHandlers });

	logPass("Extension registration verified!");
}
