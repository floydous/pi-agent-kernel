import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getGlobalRawConfig,
  getProjectConfigPath,
  loadKernelConfig,
  registerAgentKernelCommand,
  saveGlobalKernelConfig,
} from "../../src/config";

async function renderSettings(cwd: string, config: any): Promise<any> {
  let command: any;
  let factory: any;
  registerAgentKernelCommand(
    { registerCommand(_name: string, definition: any) { command = definition; } } as any,
    {
      getConfig: () => config,
      invalidateConfig() {},
      clearCaches() {},
    },
  );
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: {
      custom: async (componentFactory: any) => { factory = componentFactory; },
      notify() {},
    },
  };
  await command.handler("", ctx);
  return factory(
    { requestRender() {} },
    { fg: (_color: string, value: string) => value, bold: (value: string) => value },
    {},
    () => {},
  );
}

export async function run(): Promise<void> {
  console.log("=== Running Configuration Scope Precedence Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "scope-precedence-"));
  const previousPiDir = process.env.PI_DIR;
  process.env.PI_DIR = path.join(base, "pi");
  try {
    const workspace = path.join(base, "workspace");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    const projectPath = path.join(workspace, ".pi", "config.toml");
    fs.writeFileSync(projectPath, "[retrieval]\ndefault_profile = \"lean\"\n", "utf8");

    let config = loadKernelConfig(workspace, { projectTrusted: true });
    let component = await renderSettings(workspace, config);
    component.handleInput("G");
    component.handleInput("\x1b");
    config = loadKernelConfig(workspace, { projectTrusted: true });
    assert.equal(config.retrieval.default_profile, "lean");
    assert.equal(fs.readFileSync(projectPath, "utf8").includes("default_profile"), false, "local-to-global must remove the project override");
    assert.equal(getGlobalRawConfig().retrieval.default_profile, "lean", "global value must be written");

    saveGlobalKernelConfig({ retrieval: { default_profile: "full" } });
    config = loadKernelConfig(workspace, { projectTrusted: true });
    component = await renderSettings(workspace, config);
    component.handleInput("G");
    component.handleInput("\x1b");
    config = loadKernelConfig(workspace, { projectTrusted: true });
    assert.equal(config.retrieval.default_profile, "full");
    assert.equal(getProjectConfigPath(workspace), projectPath);
    assert.equal(fs.existsSync(projectPath), true, "global-to-local must write a project override");
    assert.equal(getGlobalRawConfig().retrieval?.default_profile, undefined, "global override must be removed");

    // Verify Tab 1 engine selection does not exit on Space/Enter and overrides project config cleanly even when global also defines default_profile
    saveGlobalKernelConfig({ retrieval: { default_profile: "lean" } });
    fs.writeFileSync(projectPath, "[retrieval]\ndefault_profile = \"full\"\n", "utf8");
    config = loadKernelConfig(workspace, { projectTrusted: true });
    let closedCount = 0;
    let tab1Command: any;
    let tab1Factory: any;
    registerAgentKernelCommand(
      { registerCommand(_name: string, definition: any) { tab1Command = definition; } } as any,
      {
        getConfig: () => config,
        invalidateConfig() {
          config = loadKernelConfig(workspace, { projectTrusted: true });
        },
        clearCaches() {},
      },
    );
    await tab1Command.handler("engine", {
      cwd: workspace,
      hasUI: true,
      mode: "tui",
      isProjectTrusted: () => true,
      ui: {
        custom: async (componentFactory: any) => { tab1Factory = componentFactory; },
        notify() {},
      },
    });
    const tab1Comp = tab1Factory(
      { requestRender() {} },
      { fg: (_color: string, value: string) => value, bold: (value: string) => value },
      {},
      () => { closedCount++; },
    );
    // Navigate up from Full (index 2) to Lean (index 1) and press Kitty Space -> must NOT close yet
    await tab1Comp.handleInput("\x1b[A");
    await tab1Comp.handleInput("\x1b[32u");
    assert.equal(closedCount, 0, "Selecting profile with Space in Tab 1 must not exit the modal");
    // Press Kitty Escape -> closes and applies Lean to project config (where override lives)
    await tab1Comp.handleInput("\x1b[27u");
    assert.equal(closedCount, 1, "Escape must close and apply changes");
    assert.equal(loadKernelConfig(workspace, { projectTrusted: true }).retrieval.default_profile, "lean", "Effective engine profile must switch to lean");

    console.log("! Local/global scope changes now match effective configuration precedence!");
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
