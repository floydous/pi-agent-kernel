import fs from "node:fs";
import path from "node:path";
import kernelExt, { renderKernelGuidance, KERNEL_GUIDANCE_MARKER } from "../../src/index";
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
      getActiveTools() { return [...registeredTools.map((tool) => tool.name), "bash"]; },
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

    // Gating is asserted on a synthetic fixture with unique sentinel text per block, so these
    // checks test the rendering mechanism and never pin the wording of the shipped prompt asset.
    const sentinel = [
      "## Prefer Kernel Tools",
      "<!-- KERNEL:CODE_SEARCH -->\nSENTINEL_CODE_SEARCH\n<!-- /KERNEL:CODE_SEARCH -->",
      "<!-- KERNEL:READ -->\nSENTINEL_READ\n<!-- /KERNEL:READ -->",
      "<!-- KERNEL:EDIT -->\nSENTINEL_EDIT\n<!-- /KERNEL:EDIT -->",
      "<!-- KERNEL:BASH -->\nSENTINEL_BASH\n<!-- /KERNEL:BASH -->",
      "SENTINEL_ALWAYS",
    ].join("\n");
    // The marker regex must tolerate BOTH line endings. A git checkout with core.autocrlf
    // produces CRLF, and a pattern requiring a bare LF never matches, which silently disables
    // gating entirely. Assert both forms explicitly so this cannot regress.
    for (const [eol, label] of [["\n", "LF"], ["\r\n", "CRLF"]] as const) {
      const eolSentinel = [
        "## Tool Selection",
        `<!-- KERNEL:CODE_SEARCH -->${eol}SENTINEL_CODE_SEARCH${eol}<!-- /KERNEL:CODE_SEARCH -->${eol}`,
        "SENTINEL_ALWAYS",
      ].join("");
      const eolOff = renderKernelGuidance(eolSentinel, new Set(["read", "edit", "bash"]));
      assertPass(`gating drops the code_search block on ${label} input`,
        !eolOff.includes("SENTINEL_CODE_SEARCH") && !eolOff.includes("<!-- KERNEL:") && eolOff.includes("SENTINEL_ALWAYS"),
        { eol: label, eolOff });
      const eolOn = renderKernelGuidance(eolSentinel, new Set(["read", "edit", "bash", "code_search"]));
      assertPass(`gating keeps the code_search block on ${label} input`,
        eolOn.includes("SENTINEL_CODE_SEARCH") && !eolOn.includes("<!-- KERNEL:"),
        { eol: label, eolOn });
    }
    const sentinelOff = renderKernelGuidance(sentinel, new Set(["read", "edit", "bash"]));
    assertPass("gating drops a block whose tool is inactive and keeps the rest",
      !sentinelOff.includes("SENTINEL_CODE_SEARCH") && sentinelOff.includes("SENTINEL_READ") &&
      sentinelOff.includes("SENTINEL_EDIT") && sentinelOff.includes("SENTINEL_BASH") &&
      sentinelOff.includes("SENTINEL_ALWAYS"),
      { sentinelOff });
    const sentinelOn = renderKernelGuidance(sentinel, new Set(["read", "edit", "bash", "code_search"]));
    assertPass("gating includes a block whose tool is active",
      sentinelOn.includes("SENTINEL_CODE_SEARCH") && !sentinelOn.includes("<!-- KERNEL:"),
      { sentinelOn });

    // Real asset: whatever its wording, the rendered prompt must not advertise a Kernel tool
    // that is not currently registered, and must leave no unconsumed block markers.
    const promptAsset = fs.readFileSync(path.resolve(process.cwd(), "AGENT_KERNEL_SYS_PROMPT.md"), "utf8");
    const KERNEL_TOOLS = ["read", "edit", "code_search"];
    for (const active of [["read", "edit", "bash"], ["read", "edit", "bash", "code_search"]]) {
      const rendered = renderKernelGuidance(promptAsset, new Set(active));
      const advertised = KERNEL_TOOLS.filter((t) => !active.includes(t) && new RegExp(`\`${t}\``).test(rendered));
      assertPass(`prompt never advertises a tool outside the active set ${JSON.stringify(active)}`,
        advertised.length === 0 && !rendered.includes("<!-- KERNEL:"),
        { advertised, rendered });
    }

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
    const guidedPrompt = String(result?.systemPrompt || "");
    // The marker line is the stable contract: it is what makes the injection detectable and
    // idempotent. The prompt's own section headings are content, not contract, so they are not
    // asserted here.
    assertPass("before_agent_start injects kernel guidance under the stable marker",
      guidedPrompt.includes(KERNEL_GUIDANCE_MARKER) && guidedPrompt.startsWith("Base system prompt") &&
      guidedPrompt.length > "Base system prompt".length,
      { guidedPrompt });
    const secondResult = await beforeAgentStart(
      { systemPrompt: result.systemPrompt, systemPromptOptions: { contextFiles: [] } },
      sessionCtx,
    );
    assertPass("before_agent_start does not duplicate guidance", secondResult?.systemPrompt === result.systemPrompt);

    const offPiDir = fs.mkdtempSync(path.join(ws.tempDir, "off-pi-"));
    const previousOffPiDir = process.env.PI_DIR;
    fs.writeFileSync(path.join(offPiDir, "config.toml"), "[retrieval]\ndefault_profile = \"off\"\n", "utf8");
    const offTools: any[] = [];
    const offHandlers: Record<string, Function[]> = {};
    const offPi: any = {
      registerTool(tool: any) { offTools.push(tool); },
      registerCommand() {},
      getAllTools() { return []; },
      getActiveTools() { return ["edit", "bash"]; },
      on(event: string, handler: Function) {
        offHandlers[event] = offHandlers[event] || [];
        offHandlers[event].push(handler);
        return () => {};
      },
    };
    process.env.PI_DIR = offPiDir;
    try {
      await kernelExt(offPi);
      await offHandlers.session_start?.[0]?.({}, sessionCtx);
      const offResult = await offHandlers.before_agent_start?.[0]?.(
        { systemPrompt: "BASE USER POLICY: preserve this policy verbatim.", systemPromptOptions: { contextFiles: [] } },
        sessionCtx,
      );
      const offPrompt = String(offResult?.systemPrompt || "");
      const offAdvertised = KERNEL_TOOLS.filter((t) => new RegExp(`\`${t}\``).test(offPrompt));
      assertPass("off profile advertises no gated Kernel tool and preserves the user base policy",
        offAdvertised.length === 0 && !offPrompt.includes("<!-- KERNEL:") &&
        !offPrompt.includes("get_repo_map") && !offPrompt.includes("repo_map") &&
        !offPrompt.includes("ast_search") && !offPrompt.includes("lsp") &&
        offPrompt.includes("BASE USER POLICY: preserve this policy verbatim.") &&
        offPrompt.includes(KERNEL_GUIDANCE_MARKER) &&
        offPrompt.length > "BASE USER POLICY: preserve this policy verbatim.".length,
        { offAdvertised, offPrompt });
    } finally {
      if (previousOffPiDir === undefined) delete process.env.PI_DIR;
      else process.env.PI_DIR = previousOffPiDir;
      fs.rmSync(offPiDir, { recursive: true, force: true });
    }

    const collisionTools: any[] = [];
    const collisionHandlers: Record<string, Function[]> = {};
    const collisionPi: any = {
      registerTool(tool: any) { collisionTools.push(tool); },
      registerCommand() {},
      getAllTools() {
        return [{ name: "read", sourceInfo: { path: "/mock/other-extension.ts" } }];
      },
      getActiveTools() { return ["read", "edit", "code_search", "bash"]; },
      on(event: string, handler: Function) {
        collisionHandlers[event] = collisionHandlers[event] || [];
        collisionHandlers[event].push(handler);
        return () => {};
      },
    };
    await kernelExt(collisionPi);
    await collisionHandlers.session_start?.[0]?.({}, sessionCtx);
    const collisionResult = await collisionHandlers.before_agent_start?.[0]?.(
      { systemPrompt: "Base system prompt", systemPromptOptions: { contextFiles: [] } },
      sessionCtx,
    );
    const collisionPrompt = String(collisionResult?.systemPrompt || "");
    const collisionAdvertised = KERNEL_TOOLS.filter((t) => new RegExp(`\`${t}\``).test(collisionPrompt));
    assertPass("colliding tools do not receive Kernel capability guidance",
      !collisionPrompt.includes("`read`") &&
      collisionAdvertised.every((t) => t !== "read") &&
      collisionPrompt.includes("Tool Integration Notice") &&
      collisionPrompt.includes(KERNEL_GUIDANCE_MARKER),
      { collisionAdvertised, collisionPrompt });

    logPass("Deferred registration, guidance, and startup indexing verified!");
  } finally {
    if (originalPiDir) process.env.PI_DIR = originalPiDir;
    else delete process.env.PI_DIR;
    ws.cleanup();
  }
}
