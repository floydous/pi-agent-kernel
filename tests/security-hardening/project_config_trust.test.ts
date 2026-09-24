import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import kernelExtension from "../../src/index";
import { getProjectConfigPath, loadKernelConfig } from "../../src/config";
import { loadPersistedProfile } from "../../src/retrieval/search_config";
import { HybridSearchIndex } from "../../src/retrieval/search_index";

export async function run(): Promise<void> {
  console.log("=== Running Project Configuration Trust Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-trust-"));
  const previousPiDir = process.env.PI_DIR;
  const previousCwd = process.cwd();
  const previousTools = process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
  process.env.PI_DIR = path.join(base, "pi");
  delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;

  try {
    const workspace = path.join(base, "workspace");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "agent-kernel"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".pi", "config.toml"),
      "[retrieval]\ndefault_profile = \"lean\"\nenable_tools = true\n\n[safety]\nenable_epistemic_guard = false\n\n[instructions]\nenabled = false\n",
    );
    fs.writeFileSync(
      path.join(workspace, "config.toml"),
      "[retrieval]\ndefault_profile = \"off\"\n\n[safety]\nenable_epistemic_guard = true\n",
    );
    fs.writeFileSync(
      path.join(workspace, "agent-kernel", "config.toml"),
      "[retrieval]\ndefault_profile = \"hybrid\"\n",
    );

    assert.equal(
      path.basename(path.dirname(getProjectConfigPath(workspace)!)),
      ".pi",
      "only .pi/config.toml may be discovered",
    );

    const untrusted = loadKernelConfig(workspace);
    assert.equal(untrusted.safety.enable_epistemic_guard, true);
    assert.equal(untrusted.retrieval.enable_tools, false);
    assert.equal(untrusted.retrieval.default_profile, "lean");
    assert.equal(loadPersistedProfile(workspace, false), "lean");
    assert.equal(
      new HybridSearchIndex(workspace, undefined, { projectTrusted: false }).getProfile(),
      "lean",
    );

    const trusted = loadKernelConfig(workspace, { projectTrusted: true });
    assert.equal(trusted.safety.enable_epistemic_guard, false);
    assert.equal(trusted.instructions.enabled, false);
    assert.equal(trusted.retrieval.enable_tools, true);
    assert.equal(trusted.retrieval.default_profile, "lean");
    assert.equal(loadPersistedProfile(workspace, true), "lean");
    assert.equal(
      new HybridSearchIndex(workspace, undefined, { projectTrusted: true }).getProfile(),
      "lean",
    );

    process.chdir(workspace);
    const tools: string[] = [];
    let sessionStart: any;
    let beforeAgentStart: any;
    const pi: any = {
      registerTool(tool: any) { tools.push(tool.name); },
      registerCommand() {},
      getAllTools() { return []; },
      on(event: string, handler: any) {
        if (event === "session_start") sessionStart = handler;
        if (event === "before_agent_start") beforeAgentStart = handler;
        return () => {};
      },
    };
    await kernelExtension(pi);
    assert.deepEqual(tools, []);
    assert.equal(tools.length === 0, true, "project config must not expose tools before a trusted session context");

    const context: any = {
      cwd: workspace,
      hasUI: false,
      mode: "text",
      ui: {},
      sessionManager: {
        getCwd: () => workspace,
        getSessionId: () => "config-trust",
      },
    };
    const beforeTrusted = await beforeAgentStart(
      { systemPrompt: "BASE" },
      context,
    );
    assert.equal(
      String(beforeTrusted?.systemPrompt || "").includes("## Agent Kernel Guidance"),
      true,
      "untrusted project must not suppress trusted global guidance",
    );
    await sessionStart({}, { ...context, isProjectTrusted: () => true });
    const afterTrusted = await beforeAgentStart(
      { systemPrompt: "BASE" },
      { ...context, isProjectTrusted: () => true },
    );
    assert.equal(
      String(afterTrusted?.systemPrompt || "").includes("## Agent Kernel Guidance"),
      false,
      "trusted project setting must be applied after session trust is known",
    );
    assert.deepEqual(tools, ["read", "edit", "code_search", "get_repo_map", "ast_search", "lsp"]);

    console.log("✓ Untrusted project config is ignored; trusted .pi config alone is applied!");
  } finally {
    process.chdir(previousCwd);
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    if (previousTools === undefined) delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
    else process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS = previousTools;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
