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
      registerTool(tool: any) { registeredTools.push(tool); },
      registerCommand(name: string, def: any) { registeredCommands.push({ name, def }); },
      getAllTools() {
        return registeredTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptGuidelines: [],
          sourceInfo: { path: "/mock/kernel.ts", source: "/mock/kernel.ts", scope: "user", origin: "top-level" },
        }));
      },
      on(event: string, handler: any) {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
        return () => {};
      },
    };

    delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
    await kernelExt(mockPi);
    assertPass("Tool registration waits for complete extension load order", registeredTools.length === 0);
    const sessionStart = eventHandlers.session_start?.[0];
    assertPass("session_start handler is registered", typeof sessionStart === "function");
    const sessionCtx: any = {
      cwd: process.cwd(),
      hasUI: false,
      isProjectTrusted: () => false,
      ui: { notify() {} },
      sessionManager: { getCwd: () => process.cwd() },
    };
    await sessionStart({}, sessionCtx);

    const toolNames = registeredTools.map((tool: any) => tool.name);
    assertPass("Exact core essential tools are registered by default",
      toolNames.length === 3 && ["read", "edit", "code_search"].every((name) => toolNames.includes(name)),
      { toolNames });
    assertPass("Speculative tools are gated by default",
      !toolNames.includes("ast_search") && !toolNames.includes("get_repo_map") && !toolNames.includes("lsp"),
      { toolNames });

    const optInTools: any[] = [];
    const optInHandlers: Record<string, Function[]> = {};
    const mockOptInPi: any = {
      registerTool(tool: any) { optInTools.push(tool); },
      registerCommand() {},
      getAllTools() { return []; },
      on(event: string, handler: any) {
        if (!optInHandlers[event]) optInHandlers[event] = [];
        optInHandlers[event].push(handler);
        return () => {};
      },
    };
    process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS = "1";
    try {
      await kernelExt(mockOptInPi);
      await optInHandlers.session_start?.[0]?.({}, sessionCtx);
      const optInNames = optInTools.map((tool: any) => tool.name);
      assertPass("Speculative tools register after trusted opt-in decision",
        ["ast_search", "get_repo_map", "lsp"].every((name) => optInNames.includes(name)),
        { optInNames });
    } finally {
      delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
    }

    assertPass("At least one command is registered", registeredCommands.length > 0);
    const beforeAgentStart = eventHandlers.before_agent_start?.[0];
    const result = await beforeAgentStart(
      { systemPrompt: "Base system prompt", systemPromptOptions: { contextFiles: [] } },
      sessionCtx,
    );
    assertPass("before_agent_start injects kernel guidance",
      String(result?.systemPrompt || "").includes("## Agent Kernel Guidance") &&
      String(result?.systemPrompt || "").includes("Turn 1 Grounding"),
      { result });
    const secondResult = await beforeAgentStart(
      { systemPrompt: result.systemPrompt, systemPromptOptions: { contextFiles: [] } },
      sessionCtx,
    );
    assertPass("before_agent_start does not duplicate guidance", secondResult?.systemPrompt === result.systemPrompt);

    logPass("Deferred registration, guidance, and startup indexing verified!");
  } finally {
    if (originalPiDir) process.env.PI_DIR = originalPiDir;
    else delete process.env.PI_DIR;
    ws.cleanup();
  }
}
