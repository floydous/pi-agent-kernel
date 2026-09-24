import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PI_LSP_BIN_DIR,
  clearExecutableCache,
  findExecutable,
  getExtensionLspBinDir,
  resolveLspServer,
} from "../../src/lsp/lsp_registry";

export async function run(): Promise<void> {
  console.log("=== Running Trusted LSP Executable Resolution Tests ===");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-resolution-"));
  const previousPiDir = process.env.PI_DIR;
  const previousPath = process.env.PATH;
  const previousPathUpper = process.env.Path;

  try {
    const workspace = path.join(base, "workspace");
    const workspaceBin = path.join(workspace, "bin", "lsp");
    const workspacePath = path.join(workspace, "path-tools");
    fs.mkdirSync(workspaceBin, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const maliciousDirect = path.join(workspaceBin, `vtsls${suffix}`);
    const maliciousPath = path.join(workspacePath, `vtsls${suffix}`);
    fs.writeFileSync(maliciousDirect, "malicious direct workspace binary", "utf8");
    fs.writeFileSync(maliciousPath, "malicious PATH workspace binary", "utf8");
    process.env.PATH = `${workspacePath}${path.delimiter}${previousPath || ""}`;
    process.env.Path = process.env.PATH;
    clearExecutableCache();

    const direct = findExecutable("vtsls", [workspaceBin], [workspace]);
    assert.notEqual(direct, maliciousDirect, "workspace direct binary directory must be excluded");
    const fromPath = findExecutable("vtsls", [], [workspace]);
    assert.notEqual(fromPath, maliciousPath, "workspace PATH directory must be excluded");
    const resolved = resolveLspServer("typescript", [workspaceBin], [workspace]);
    assert.ok(
      !resolved || !path.resolve(resolved.binPath).startsWith(path.resolve(workspace) + path.sep),
      "resolved language server must not come from the workspace",
    );
    assert.equal(
      path.resolve(PI_LSP_BIN_DIR).startsWith(path.resolve(workspace) + path.sep),
      false,
      "package LSP directory must not be workspace-derived",
    );

    process.env.PI_DIR = path.join(base, "fresh-pi");
    const freshLspDir = getExtensionLspBinDir();
    assert.equal(
      fs.existsSync(path.join(base, "fresh-pi", "lsp", "bin")),
      false,
      "bin-dir discovery must not create directories at import/call time",
    );
    assert.ok(freshLspDir);
    const source = fs.readFileSync(path.join(process.cwd(), "src", "lsp", "lsp_registry.ts"), "utf8");
    assert.equal(source.includes('path.join(process.cwd(), "bin", "lsp")'), false);

    console.log("✓ Workspace direct and PATH executables are excluded from LSP resolution!");
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_DIR;
    else process.env.PI_DIR = previousPiDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathUpper === undefined) delete process.env.Path;
    else process.env.Path = previousPathUpper;
    clearExecutableCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
