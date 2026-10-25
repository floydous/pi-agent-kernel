import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KernelConfigError,
  getGlobalConfigPath,
  loadKernelConfig,
  mergeKernelConfig,
  saveGlobalKernelConfig,
  validateConfigDocument,
} from "../../src/config";
import { parseToml } from "../../src/config/toml";

export async function run(): Promise<void> {
  console.log("=== Running Kernel Configuration Validation Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "config-validation-"));
  const previousPiDir = process.env.PI_DIR;
  process.env.PI_DIR = path.join(base, "pi");

  try {
    const valid = validateConfigDocument(parseToml(`
[retrieval]
default_profile = "lean"
max_search_results = 8
enable_tools = true
repo_map_budget = 2048
repo_map_min_files = 10
repo_map_min_bytes = 50000
[safety]
max_total_bytes = 32768
[lsp]
disabled_servers = ["typescript"]
idle_timeout_ms = 300000
`));
    assert.equal(valid.retrieval.max_search_results, 8);
    assert.equal(valid.safety.max_total_bytes, 32768);
    assert.equal("enable_tools" in valid.retrieval, false, "deprecated enable_tools must not enter valid config");
    assert.equal("repo_map_budget" in valid.retrieval, false, "deprecated repo_map_budget must not enter valid config");

    const invalidDocuments: Array<[string, string]> = [
      ["wrong boolean", `[safety]\nenable_epistemic_guard = "false"`],
      ["invalid enum", `[retrieval]\ndefault_profile = "maximum"`],
      ["negative range", `[safety]\nmax_lines = -1`],
      ["excessive integer", `[safety]\nmax_total_bytes = 999999999999`],
      ["unknown section", `[unknown]\nvalue = true`],
      ["unknown key", `[safety]\nunknown = true`],
    ];
    for (const [label, source] of invalidDocuments) {
      assert.throws(
        () => validateConfigDocument(parseToml(source)),
        KernelConfigError,
        `${label} must be rejected`,
      );
    }

    const target = validateConfigDocument({ safety: { enable_epistemic_guard: false } });
    assert.throws(() =>
      mergeKernelConfig(target, {
        safety: { enable_epistemic_guard: true },
        retrieval: { max_search_results: 0 },
      }),
    );
    assert.equal(
      target.safety.enable_epistemic_guard,
      false,
      "failed validation must not partially mutate the previous config",
    );

    const workspace = path.join(base, "workspace");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    const globalDir = path.dirname(getGlobalConfigPath());
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      getGlobalConfigPath(),
      `[retrieval]\ndefault_profile = "full"\n\n[safety]\nenable_epistemic_guard = false\n`,
    );
    fs.writeFileSync(
      path.join(workspace, ".pi", "config.toml"),
      `[safety]\nenable_epistemic_guard = true\nmax_lines = 0\n`,
    );
    const loaded = loadKernelConfig(workspace, { projectTrusted: true });
    assert.equal(loaded.retrieval.default_profile, "full", "valid global values must survive invalid project config");
    assert.equal(loaded.safety.enable_epistemic_guard, false, "invalid project config must not partially override global safety");

    const invalidGlobal = "[safety]\nmax_total_bytes = 0\n";
    fs.writeFileSync(getGlobalConfigPath(), invalidGlobal);
    const defaults = loadKernelConfig(workspace, { projectTrusted: false });
    assert.equal(defaults.safety.max_total_bytes, 20 * 1024, "invalid global config must fall back to defaults");

    fs.writeFileSync(getGlobalConfigPath(), invalidGlobal);
    assert.throws(
      () => saveGlobalKernelConfig({ retrieval: { default_profile: "lean" } }),
      KernelConfigError,
      "save must reject an invalid existing document rather than overwrite it",
    );
    assert.equal(fs.readFileSync(getGlobalConfigPath(), "utf8"), invalidGlobal);

    console.log("✓ Valid ranges merge atomically; invalid types, keys, and files fail closed!");
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
