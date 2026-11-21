import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import kernelExt, {
	formatEngineNotification,
	getPendingEngineNotification,
	getLastNotifiedProfile,
	clearEngineNotificationState,
	KERNEL_GUIDANCE_MARKER,
} from "../../src/index";
import { assertPass, logPass, createTestWorkspace } from "../_setup";

export async function run(): Promise<void> {
	console.log("=== Running Engine Switch Suffix Notification Test Suite ===");

	clearEngineNotificationState();
	const ws = createTestWorkspace("engine_switch_test_");
	const originalPiDir = process.env.PI_DIR;
	process.env.PI_DIR = ws.tempDir;

	try {
		const registeredTools: any[] = [];
		const registeredCommands: any[] = [];
		const eventHandlers: Record<string, Function[]> = {};
		const mockPi: any = {
			registerTool(tool: any) { registeredTools.push(tool); },
			registerCommand(name: string, def: any) { registeredCommands.push({ name, def }); },
			getAllTools() { return []; },
			getActiveTools() { return ["read", "edit", "code_search", "bash"]; },
			on(event: string, handler: any) {
				if (!eventHandlers[event]) eventHandlers[event] = [];
				eventHandlers[event].push(handler);
				return () => {};
			},
		};

		await kernelExt(mockPi);

		const sessionId = "session-123";
		const sessionCtx: any = {
			cwd: ws.tempDir,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { notify() {} },
			sessionManager: {
				getCwd: () => ws.tempDir,
				getSessionId: () => sessionId,
				getSessionFile: () => path.join(ws.tempDir, "session.jsonl"),
			},
		};

		// 1. Session start initializes state cleanly
		console.log("1. Testing clean session initialization...");
		const sessionStart = eventHandlers.session_start?.[0];
		assert.ok(sessionStart, "session_start handler must be registered");
		await sessionStart({}, sessionCtx);

		assert.equal(getLastNotifiedProfile(sessionId), "lean");
		assert.equal(getPendingEngineNotification(sessionId), null);

		const beforeAgentStart = eventHandlers.before_agent_start?.[0];
		assert.ok(beforeAgentStart, "before_agent_start handler must be registered");

		// Turn 1: normal turn, no notification
		const turn1Res = await beforeAgentStart(
			{ systemPrompt: "BASE_SYSTEM_PROMPT", systemPromptOptions: { contextFiles: [] } },
			sessionCtx,
		);
		assert.equal(turn1Res.message, undefined, "Turn 1 must not emit notification message");
		const canonicalPrompt = turn1Res.systemPrompt;
		assert.ok(canonicalPrompt.includes("BASE_SYSTEM_PROMPT"));

		// 2. Switch to Full profile mid-session
		console.log("2. Testing mid-session switch to Full profile...");
		const cmd = registeredCommands.find((c) => c.name === "agent-kernel");
		assert.ok(cmd, "/agent-kernel command must be registered");

		await cmd.def.handler("set profile full", sessionCtx);

		// Verify notification is queued with instruction-engineered XML
		const pendingFull = getPendingEngineNotification(sessionId);
		assert.ok(pendingFull, "Pending notification must be queued for Full mode");
		assert.ok(pendingFull.includes("<system_notification>"), "Notification must use <system_notification> tag");
		assert.ok(pendingFull.includes("Full Mode"), "Notification must specify Full Mode");
		assert.ok(pendingFull.includes("768-dim ModernBERT"), "Notification must mention neural embeddings");
		assert.ok(!pendingFull.includes("Avoid"), "Must not contain negative prohibitions");
		assert.ok(!pendingFull.includes("Do not"), "Must not contain negative prohibitions");

		// Turn 2: before_agent_start emits suffix message, keeps systemPrompt identical
		const turn2Res = await beforeAgentStart(
			{ systemPrompt: "BASE_SYSTEM_PROMPT", systemPromptOptions: { contextFiles: [] } },
			sessionCtx,
		);
		assert.ok(turn2Res.message, "Turn 2 must emit message");
		assert.equal(turn2Res.message.customType, "agent-kernel-engine-notification");
		assert.equal(turn2Res.message.display, true);
		assert.equal(turn2Res.message.content, pendingFull);

		// Crucial KV cache invariant: systemPrompt string must remain 100% bit-for-bit identical!
		assert.equal(turn2Res.systemPrompt, canonicalPrompt, "System prompt prefix MUST remain identical to preserve KV cache!");
		assert.equal(getLastNotifiedProfile(sessionId), "full");
		assert.equal(getPendingEngineNotification(sessionId), null, "Pending notification must be cleared after emission");

		// Turn 3: subsequent turn without switch emits no message
		const turn3Res = await beforeAgentStart(
			{ systemPrompt: "BASE_SYSTEM_PROMPT", systemPromptOptions: { contextFiles: [] } },
			sessionCtx,
		);
		assert.equal(turn3Res.message, undefined, "Turn 3 must not emit repeated message");
		assert.equal(turn3Res.systemPrompt, canonicalPrompt);

		// 3. Intra-turn rapid switching (debouncing / net-state collapsing)
		console.log("3. Testing intra-turn rapid switching and net-state debouncing...");
		// Currently in Full mode. Switch to Lean, then immediately back to Full before agent start
		await cmd.def.handler("set profile lean", sessionCtx);
		assert.ok(getPendingEngineNotification(sessionId)?.includes("Lean Mode"));

		// User changes mind and switches back to Full before next prompt
		await cmd.def.handler("set profile full", sessionCtx);
		// Net change is ZERO (agent was already notified about Full)
		assert.equal(getPendingEngineNotification(sessionId), null, "Net-zero intra-turn switch must collapse to no-op");

		const turn4Res = await beforeAgentStart(
			{ systemPrompt: "BASE_SYSTEM_PROMPT", systemPromptOptions: { contextFiles: [] } },
			sessionCtx,
		);
		assert.equal(turn4Res.message, undefined, "Net-zero switch must emit zero messages");

		// 4. Switch to Lean mode in a later turn
		console.log("4. Testing inter-turn transition back to Lean mode...");
		await cmd.def.handler("set profile lean", sessionCtx);
		const turn5Res = await beforeAgentStart(
			{ systemPrompt: "BASE_SYSTEM_PROMPT", systemPromptOptions: { contextFiles: [] } },
			sessionCtx,
		);
		assert.ok(turn5Res.message, "Turn 5 must emit message for Lean mode");
		assert.ok(turn5Res.message.content.includes("Lean Mode (lexical BM25"));
		assert.equal(turn5Res.systemPrompt, canonicalPrompt, "System prompt prefix must still remain 100% identical");

		// 5. Off notification accurately states code_search returns an error
		console.log("5. Testing Off profile notification wording and Pi 1.6.0 <docs> stripping...");
		const offNotice = formatEngineNotification("off");
		assert.ok(offNotice.includes("disabled and returns an error"), "Off notification must state code_search returns an error");
		assert.ok(!offNotice.includes("will return empty results"), "Off notification must not claim empty results");

		const piDocsCmd = registeredCommands.find((c) => c.name === "pi-docs");
		assert.ok(piDocsCmd, "/pi-docs command must be registered");
		await piDocsCmd.def.handler("off", sessionCtx);
		const pi16Prompt = [
			"You are a coding assistant running inside pi.",
			"<docs>\nPi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /tmp/README.md\n- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.\n</docs>",
			"<cwd>/tmp</cwd>",
		].join("\n\n");
		const sections: Record<string, string> = {
			preamble: "You are a coding assistant running inside pi.",
			docs: "<docs>\nPi documentation...\n</docs>",
			cwd: "<cwd>/tmp</cwd>",
		};
		const docsOffRes = await beforeAgentStart(
			{ systemPrompt: pi16Prompt, systemPromptOptions: { contextFiles: [], sections } },
			sessionCtx,
		);
		assert.ok(!docsOffRes.systemPrompt.includes("<docs>"), "Pi 1.6.0 <docs> block must be stripped when pi-docs is off");
		assert.ok(!docsOffRes.systemPrompt.includes("about the harness itself"), "Pi 1.6.0 docs text must be stripped when pi-docs is off");
		assert.equal(sections.docs, undefined, "systemPromptOptions.sections.docs must be deleted when pi-docs is off");

		logPass("All Engine Switch Suffix Notification Tests Passed Successfully!");
	} finally {
		clearEngineNotificationState();
		if (originalPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = originalPiDir;
		fs.rmSync(ws.tempDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	run().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
