import assert from "node:assert/strict";
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
    // Only code_search is gated: it is the one tool whose availability depends on the retrieval
    // profile. The other Kernel tools are always registered, so they need no block.
    const sentinel = [
      "## Tool Selection",
      "<!-- KERNEL:CODE_SEARCH -->\nSENTINEL_CODE_SEARCH\n<!-- /KERNEL:CODE_SEARCH -->",
      "SENTINEL_ALWAYS",
    ].join("\n");
    // The marker regex must tolerate BOTH line endings. A git checkout with core.autocrlf
    // produces CRLF; a pattern requiring a bare \n silently never matches, which disables gating
    // entirely and ships the raw <!-- KERNEL:... --> comments. Assert on both forms explicitly.
    for (const [eol, label] of [["\n", "LF"], ["\r\n", "CRLF"]] as const) {
      const eolSentinel = [
        "## Tool Selection",
        `<!-- KERNEL:CODE_SEARCH -->${eol}SENTINEL_CODE_SEARCH${eol}<!-- /KERNEL:CODE_SEARCH -->${eol}`,
        "SENTINEL_ALWAYS",
      ].join("");
      const off = renderKernelGuidance(eolSentinel, new Set(["read", "edit", "bash"]));
      assertPass(`gating drops the code_search block on ${label} input`,
        !off.includes("SENTINEL_CODE_SEARCH") && !off.includes("<!-- KERNEL:") && off.includes("SENTINEL_ALWAYS"),
        { eol: label, off });
      const on = renderKernelGuidance(eolSentinel, new Set(["read", "edit", "bash", "code_search"]));
      assertPass(`gating keeps the code_search block on ${label} input`,
        on.includes("SENTINEL_CODE_SEARCH") && !on.includes("<!-- KERNEL:"),
        { eol: label, on });
    }

    const sentinelOff = renderKernelGuidance(sentinel, new Set(["read", "edit", "bash"]));
    assertPass("gating drops the code_search block when code_search is inactive",
      !sentinelOff.includes("SENTINEL_CODE_SEARCH") &&
      !sentinelOff.includes("<!-- KERNEL:") &&
      sentinelOff.includes("SENTINEL_ALWAYS"),
      { sentinelOff });
    const sentinelOn = renderKernelGuidance(sentinel, new Set(["read", "edit", "bash", "code_search"]));
    assertPass("gating keeps the code_search block when code_search is active",
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
      // This session has edit and bash active; only tools OUTSIDE that set may be absent.
      const offActive = ["edit", "bash"];
      const offAdvertised = KERNEL_TOOLS.filter((t) => !offActive.includes(t) && new RegExp(`\`${t}\``).test(offPrompt));
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

    const offWorkspace = path.join(ws.tempDir, "multi-off");
    const leanWorkspace = path.join(ws.tempDir, "multi-lean");
    for (const [workspace, profile] of [[offWorkspace, "off"], [leanWorkspace, "lean"]] as const) {
      fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(workspace, ".pi", "config.toml"), `[retrieval]\ndefault_profile = "${profile}"\n`, "utf8");
    }
    const searchBlock = promptAsset.match(/<!-- KERNEL:CODE_SEARCH -->\r?\n([\s\S]*?)\r?\n<!-- \/KERNEL:CODE_SEARCH -->/)?.[1]?.trim() || "";
    assert(searchBlock.length > 0, "code_search guidance block must exist");
    for (const order of [[offWorkspace, leanWorkspace], [leanWorkspace, offWorkspace]]) {
      const orderTools: any[] = [];
      const orderHandlers: Record<string, Function[]> = {};
      const orderPi: any = {
        registerTool(tool: any) { orderTools.push(tool); },
        registerCommand() {},
        getAllTools() { return []; },
        getActiveTools() { return [...orderTools.map((tool) => tool.name), "bash"]; },
        on(event: string, handler: Function) {
          orderHandlers[event] = orderHandlers[event] || [];
          orderHandlers[event].push(handler);
          return () => {};
        },
      };
      await kernelExt(orderPi);
      const contexts = order.map((cwd, index) => ({
        ...sessionCtx,
        cwd,
        isProjectTrusted: () => true,
        sessionManager: { getCwd: () => cwd, getSessionId: () => `profile-order-${index}` },
      }));
      for (const ctx of contexts) await orderHandlers.session_start?.[0]?.({}, ctx);
      const searchTools = orderTools.filter((tool) => tool.name === "code_search");
      assert.equal(searchTools.length, 1, "code_search registration must not depend on first workspace profile");
      const prompts = [];
      for (const ctx of contexts) {
        prompts.push(await orderHandlers.before_agent_start?.[0]?.(
          { systemPrompt: "Base system prompt", systemPromptOptions: { contextFiles: [] } },
          ctx,
        ));
      }
      assert.deepEqual(
        prompts.map((result: any) => String(result?.systemPrompt || "").includes(searchBlock)),
        order.map((cwd) => cwd === leanWorkspace),
        "code_search guidance must follow each workspace's profile regardless of start order",
      );
      const disabledResult = await searchTools[0].execute(
        "off-profile-check", { query: "must not search" }, undefined, undefined, contexts[order.indexOf(offWorkspace)],
      );
      assert.equal(disabledResult.isError, true, "registered search tool must remain disabled in off-profile workspaces");
      assert.match(disabledResult.content[0].text, /disabled for this workspace/);
    }

    const collisionTools: any[] = [];
    const collisionHandlers: Record<string, Function[]> = {};
    const collisionPi: any = {
      registerTool(tool: any) { collisionTools.push(tool); },
      registerCommand() {},
      getAllTools() {
        return [{ name: "code_search", sourceInfo: { path: "/mock/other-extension.ts" } }];
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
    // \r?\n: a CRLF checkout must extract the same block body as an LF one.
    const csBlock = promptAsset.match(/<!-- KERNEL:CODE_SEARCH -->\r?\n([\s\S]*?)\r?\n<!-- \/KERNEL:CODE_SEARCH -->/)?.[1] ?? "";
    assertPass("a colliding code_search drops its guidance and raises the integration notice",
      csBlock.length > 0 &&
      !collisionPrompt.includes(csBlock.trim()) &&
      !collisionPrompt.includes("<!-- KERNEL:") &&
      collisionPrompt.includes("Tool Integration Notice") &&
      collisionPrompt.includes(KERNEL_GUIDANCE_MARKER),
      { csBlock, collisionPrompt });

    logPass("Deferred registration, guidance, and startup indexing verified!");
  } finally {
    if (originalPiDir) process.env.PI_DIR = originalPiDir;
    else delete process.env.PI_DIR;
    ws.cleanup();
  }
}
