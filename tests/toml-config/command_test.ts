import * as fs from "node:fs";
import * as path from "node:path";
import {
	registerAgentKernelCommand,
	formatConfigDashboard,
	loadKernelConfig,
	getGlobalConfigPath,
} from "../../src/config";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testAgentKernelCommand(): Promise<void> {
	const ws = createTestWorkspace("agent_kernel_cmd_");
	const originalPiDir = process.env.PI_DIR;
	process.env.PI_DIR = ws.tempDir;

	try {
		let registeredCommand: any = null;
		const mockPi: any = {
			registerCommand: (name: string, def: any) => {
				if (name === "agent-kernel") {
					registeredCommand = def;
				}
			},
		};

		let currentConfig = loadKernelConfig(ws.tempDir);
		const deps = {
			getConfig: (_cwd: string) => currentConfig,
			invalidateConfig: (_cwd: string) => {
				currentConfig = loadKernelConfig(ws.tempDir);
			},
		};

		registerAgentKernelCommand(mockPi, deps);
		assertPass("Command 'agent-kernel' is registered", registeredCommand !== null, {});

		// 1. Test Dashboard formatting
		const dashboard = formatConfigDashboard(ws.tempDir, currentConfig);
		assertPass("Dashboard contains Passive Shield", dashboard.includes("Passive Shield"), { dashboard });
		assertPass("Dashboard contains Epistemic Guard", dashboard.includes("Epistemic Guard"), { dashboard });
		assertPass("Dashboard contains Profile", dashboard.includes("Profile"), { dashboard });

		// 2. Test Argument Completions
		const setCompletions = registeredCommand.getArgumentCompletions("set ");
		assertPass("Argument completions exist for 'set '", Array.isArray(setCompletions) && setCompletions.length > 0, { setCompletions });
		const statusCompletions = registeredCommand.getArgumentCompletions("stat");
		assertPass("Argument completions include 'status'", Array.isArray(statusCompletions) && statusCompletions[0].value === "status", { statusCompletions });

		// 3. Test CLI `set tools all`
		const mockCtx: any = {
			cwd: ws.tempDir,
			hasUI: false,
			mode: "text",
			ui: { notify: () => {} },
		};

		await registeredCommand.handler("set tools all", mockCtx);
		const globalPath = getGlobalConfigPath();
		assertPass("Global config file created", fs.existsSync(globalPath), { globalPath });
		const reloadedConfig = loadKernelConfig(ws.tempDir);
		assertPass("Passive Shield tools updated to true", reloadedConfig.retrieval.enable_tools === true, { reloadedConfig });

		// 4. Test CLI `set epistemic off`
		await registeredCommand.handler("set epistemic off", mockCtx);
		const epistemicOff = loadKernelConfig(ws.tempDir);
		assertPass("Epistemic guard updated to false", epistemicOff.safety.enable_epistemic_guard === false, { epistemicOff });

		// 5. Test CLI `set profile full`
		await registeredCommand.handler("set profile full", mockCtx);
		const profileFull = loadKernelConfig(ws.tempDir);
		assertPass("Retrieval profile updated to 'full'", profileFull.retrieval.default_profile === "full", { profileFull });

		// 6. Test CLI `set pi_docs off`
		await registeredCommand.handler("set pi_docs off", mockCtx);
		const piDocsOff = loadKernelConfig(ws.tempDir);
		assertPass("Pi docs updated to false", piDocsOff.instructions.pi_docs === false, { piDocsOff });

		// 7. Test CLI `reset`
		await registeredCommand.handler("reset", mockCtx);
		assertPass("Global config file removed after reset", !fs.existsSync(globalPath), { globalPath });
		const resetConfig = loadKernelConfig(ws.tempDir);
		assertPass("Reset restored default profile 'lean'", resetConfig.retrieval.default_profile === "lean", { resetConfig });
		assertPass("Reset restored default epistemic guard true", resetConfig.safety.enable_epistemic_guard === true, { resetConfig });
		assertPass("Reset restored default pi_docs true", resetConfig.instructions.pi_docs === true, { resetConfig });

		// 8. Test TUI interactive mode with hotkey 'G' applying single setting globally
		let capturedFactory: any = null;
		let notifyMessage = "";
		const mockTuiCtx: any = {
			cwd: ws.tempDir,
			hasUI: true,
			mode: "tui",
			ui: {
				custom: async (factory: any) => {
					capturedFactory = factory;
				},
				notify: (msg: string) => {
					notifyMessage = msg;
				},
			},
		};
		await registeredCommand.handler("", mockTuiCtx);
		assertPass("TUI modal registered custom component", typeof capturedFactory === "function");
		const comp = capturedFactory(
			{ requestRender: () => {} },
			{ fg: (_col: string, s: string) => s, bold: (s: string) => s },
			{},
			() => {},
		);
		// Move down to profile (index 1) and press 'G' to apply globally
		comp.handleInput("\x1b[B");
		comp.handleInput("G");
		assertPass("Global config file created by hotkey G", fs.existsSync(globalPath), { globalPath });
		assertPass("Notification emitted for global setting application", notifyMessage.includes("globally"), { notifyMessage });

		// Press 'G' again to revert/redo global setting (toggle off)
		comp.handleInput("G");
		assertPass("Notification emitted for reverting global setting", notifyMessage.includes("Reverted"), { notifyMessage });

		// Press 'G' once more to re-apply globally (toggle on)
		comp.handleInput("G");
		assertPass("Notification emitted for re-applying global setting", notifyMessage.includes("globally"), { notifyMessage });

		logPass("Agent Kernel command CLI, completions, and persistence verified!");
	} finally {
		if (originalPiDir) {
			process.env.PI_DIR = originalPiDir;
		} else {
			delete process.env.PI_DIR;
		}
		ws.cleanup();
	}
}
