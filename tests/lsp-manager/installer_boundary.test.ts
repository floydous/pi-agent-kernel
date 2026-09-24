import assert from "node:assert/strict";
import os from "node:os";
import {
  executeInstallerSpec,
  getInstallerSpecs,
} from "../../src/lsp/lsp_installer";

export async function run(): Promise<void> {
  console.log("=== Running Pinned LSP Installer Boundary Tests ===");
  const specs = getInstallerSpecs();
  assert.ok(Object.keys(specs).length >= 10);

  for (const [language, languageSpecs] of Object.entries(specs)) {
    assert.ok(languageSpecs.length > 0, `${language} must have an installer`);
    for (const spec of languageSpecs) {
      const serialized = JSON.stringify(spec.args);
      assert.doesNotMatch(serialized, /@latest|\bnightly\b/, `${language} must not install a moving version`);
      assert.doesNotMatch(serialized, /\s(?:install)\s+-g\s+[^\s]+$/, `${language} npm package must be pinned`);
      const hasVersion = spec.args.some((arg) => arg.includes("@") && /@v?\d+\.\d+\.\d+(?:[-+].+)?$/.test(arg)) ||
        spec.args.some((arg) => /^[^=\s]+==\d+\.\d+\.\d+(?:[-+].+)?$/.test(arg)) ||
        spec.args.some((arg) => /^v?\d+\.\d+\.\d+(?:[-+].+)?$/.test(arg));
      assert.ok(hasVersion, `${language} installer must contain an explicit package version`);
    }
  }

  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const result = executeInstallerSpec(specs.typescript![0]!, {
    resolve(command) {
      assert.equal(command, "npm");
      return process.platform === "win32" ? "C:\\trusted\\npm.cmd" : "/usr/bin/npm";
    },
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "installed", stderr: "" };
    },
    verify(binName) {
      assert.equal(binName, "vtsls");
      return { success: true, message: "verified", binPath: "/trusted/vtsls" };
    },
  });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.shell, false);
  assert.equal(calls[0]!.options.cwd, os.homedir());
  assert.equal(calls[0]!.options.windowsHide, true);
  assert.deepEqual(calls[0]!.args.slice(0, 2), ["install", "-g"]);

  let ran = false;
  const missing = executeInstallerSpec(specs.typescript![0]!, {
    resolve() { return null; },
    run() { ran = true; return { status: 0 }; },
  });
  assert.equal(missing.success, false);
  assert.equal(ran, false, "missing trusted package manager must not invoke a workspace command");

  let verified = false;
  const failed = executeInstallerSpec(specs.typescript![0]!, {
    resolve() { return "/usr/bin/npm"; },
    run() { return { status: 1, stdout: "", stderr: "install failed" }; },
    verify() { verified = true; return { success: true, message: "must not verify" }; },
  });
  assert.equal(failed.success, false);
  assert.match(failed.message, /install failed/);
  assert.equal(verified, false, "failed installer must not claim a verified binary");

  console.log("✓ Installer versions are pinned and execution uses trusted argument arrays only!");
}

if (require.main === module) {
  void run();
}
