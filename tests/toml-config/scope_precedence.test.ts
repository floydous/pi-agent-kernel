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
    component.handleInput("\x1b[B");
    component.handleInput("G");
    component.handleInput("\x1b");
    config = loadKernelConfig(workspace, { projectTrusted: true });
    assert.equal(config.retrieval.default_profile, "lean");
    assert.equal(fs.readFileSync(projectPath, "utf8").includes("default_profile"), false, "local-to-global must remove the project override");
    assert.equal(getGlobalRawConfig().retrieval.default_profile, "lean", "global value must be written");

    saveGlobalKernelConfig({ retrieval: { default_profile: "full" } });
    config = loadKernelConfig(workspace, { projectTrusted: true });
    component = await renderSettings(workspace, config);
    component.handleInput("\x1b[B");
    component.handleInput("G");
    component.handleInput("\x1b");
    config = loadKernelConfig(workspace, { projectTrusted: true });
    assert.equal(config.retrieval.default_profile, "full");
    assert.equal(getProjectConfigPath(workspace), projectPath);
    assert.equal(fs.existsSync(projectPath), true, "global-to-local must write a project override");
    assert.equal(getGlobalRawConfig().retrieval?.default_profile, undefined, "global override must be removed");

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
