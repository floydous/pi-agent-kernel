import crossSpawnSync from "cross-spawn";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildLspEnvironment } from "./lsp_client";
import {
  PI_LSP_BIN_DIR,
  LSP_SERVERS,
  clearExecutableCache,
  findExecutable,
} from "./lsp_registry";
import { kernelDebug } from "../safety/kernel_debug";

const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

export interface InstallResult {
  success: boolean;
  message: string;
  binPath?: string;
}

export interface InstallerSpec {
  command: string;
  args: string[];
  verifyBin: string;
  label: string;
  timeoutMs?: number;
}

export interface InstallerCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export type InstallerCommandResolver = (
  command: string,
) => string | null;
export type InstallerCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    windowsHide: true;
    timeout: number;
    encoding: "utf8";
    stdio: "pipe";
  },
) => InstallerCommandResult;

export function ensureLspBinDir(): string {
  if (!fs.existsSync(PI_LSP_BIN_DIR)) {
    fs.mkdirSync(PI_LSP_BIN_DIR, { recursive: true });
  }
  return PI_LSP_BIN_DIR;
}

const NPM_INSTALL = (
  packages: string[],
  verifyBin: string,
  label: string,
): InstallerSpec => ({
  command: "npm",
  args: ["install", "-g", ...packages],
  verifyBin,
  label,
});

const CARGO_INSTALL = (
  crate: string,
  version: string,
  verifyBin: string,
  label: string,
  extraArgs: string[] = [],
): InstallerSpec => ({
  command: "cargo",
  args: ["install", "--locked", crate, "--version", version, ...extraArgs],
  verifyBin,
  label,
});

export function getInstallerSpecs(): Record<string, InstallerSpec[]> {
  return {
    typescript: [
      NPM_INSTALL(
        ["@vtsls/language-server@0.3.0", "typescript@7.0.2"],
        "vtsls",
        "vtsls 0.3.0 and TypeScript 7.0.2",
      ),
    ],
    python: [
      {
        command: "uv",
        args: ["tool", "install", "ty==0.0.83"],
        verifyBin: "ty",
        label: "Astral ty 0.0.83",
      },
      NPM_INSTALL(["pyright@1.1.414"], "pyright-langserver", "Pyright 1.1.414"),
    ],
    go: [
      {
        command: "go",
        args: ["install", "golang.org/x/tools/gopls@v0.23.0"],
        verifyBin: "gopls",
        label: "gopls v0.23.0",
      },
    ],
    toml: [
      CARGO_INSTALL(
        "taplo-cli",
        "0.10.0",
        "taplo",
        "Taplo CLI 0.10.0",
        ["--features", "lsp"],
      ),
    ],
    shell: [
      NPM_INSTALL(
        ["bash-language-server@5.8.1"],
        "bash-language-server",
        "bash-language-server 5.8.1",
      ),
    ],
    html: [
      NPM_INSTALL(
        ["vscode-langservers-extracted@4.10.0"],
        "vscode-html-language-server",
        "vscode-langservers-extracted 4.10.0",
      ),
    ],
    json: [
      NPM_INSTALL(
        ["@biomejs/biome@2.5.14"],
        "biome",
        "Biome 2.5.14",
      ),
      NPM_INSTALL(
        ["vscode-langservers-extracted@4.10.0"],
        "vscode-json-language-server",
        "vscode-langservers-extracted 4.10.0",
      ),
    ],
    yaml: [
      NPM_INSTALL(
        ["yaml-language-server@1.24.0"],
        "yaml-language-server",
        "yaml-language-server 1.24.0",
      ),
    ],
    docker: [
      NPM_INSTALL(
        ["dockerfile-language-server-nodejs@0.15.0"],
        "docker-langserver",
        "dockerfile-language-server-nodejs 0.15.0",
      ),
    ],
    php: [
      NPM_INSTALL(
        ["intelephense@1.18.5"],
        "intelephense",
        "Intelephense 1.18.5",
      ),
    ],
    typst: [
      CARGO_INSTALL("tinymist", "0.15.2", "tinymist", "Tinymist 0.15.2"),
    ],
    csharp: [
      {
        command: "dotnet",
        args: ["tool", "install", "-g", "csharp-ls", "--version", "0.28.0"],
        verifyBin: "csharp-ls",
        label: "csharp-ls 0.28.0",
      },
    ],
    ruby: [
      {
        command: "gem",
        args: ["install", "ruby-lsp", "--version", "0.26.11", "--no-document"],
        verifyBin: "ruby-lsp",
        label: "ruby-lsp 0.26.11",
      },
    ],
    sql: [
      {
        command: "go",
        args: ["install", "github.com/sqls-server/sqls@v0.2.48"],
        verifyBin: "sqls",
        label: "sqls v0.2.48",
      },
    ],
    latex: [
      CARGO_INSTALL("texlab", "4.3.2", "texlab", "Texlab 4.3.2"),
    ],
    protobuf: [
      CARGO_INSTALL("protols", "0.14.1", "protols", "Protols 0.14.1"),
    ],
  };
}

function defaultResolver(command: string): string | null {
  return findExecutable(command, [], [process.cwd()]);
}

function defaultRunner(
  command: string,
  args: string[],
  options: Parameters<InstallerCommandRunner>[2],
): InstallerCommandResult {
  return crossSpawnSync(command, args, options);
}

export function executeInstallerSpec(
  spec: InstallerSpec,
  dependencies: {
    resolve?: InstallerCommandResolver;
    run?: InstallerCommandRunner;
    verify?: (binName: string) => InstallResult;
  } = {},
): InstallResult {
  const resolve = dependencies.resolve || defaultResolver;
  const run = dependencies.run || defaultRunner;
  const verify = dependencies.verify || ((binName: string) =>
    verifyInstalledBinary(binName));

  let executable: string | null;
  try {
    executable = resolve(spec.command);
  } catch (error) {
    return {
      success: false,
      message: `Unable to resolve trusted ${spec.command} executable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!executable) {
    return {
      success: false,
      message: `Required package manager '${spec.command}' was not found in a trusted executable directory.`,
    };
  }

  try {
    const result = run(executable, spec.args, {
      cwd: os.homedir(),
      env: buildLspEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: spec.timeoutMs || DEFAULT_INSTALL_TIMEOUT_MS,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      throw new Error(detail || `${spec.command} exited with status ${result.status}`);
    }
    return verify(spec.verifyBin);
  } catch (error) {
    return {
      success: false,
      message: `Failed to install ${spec.label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function verifyInstalledBinary(binName: string): InstallResult {
  clearExecutableCache();
  const bin = findExecutable(binName, [], [process.cwd()]);
  if (bin) {
    return {
      success: true,
      message: `Successfully installed ${binName} (${bin})`,
      binPath: bin,
    };
  }
  return {
    success: false,
    message: `Installer completed, but trusted binary '${binName}' was not found.`,
  };
}

const MANUAL_INSTALLS: Record<string, string> = {
  rust: "Install rust-analyzer through a reviewed rustup toolchain, then rerun /lsp install rust.",
  markdown: "Install Marksman 2026-02-08 with your system package manager, then rerun /lsp install markdown.",
  cpp: "Install reviewed LLVM/clangd 23.1.2, then rerun /lsp install cpp.",
  zig: "Install reviewed ZLS 0.16.0, then rerun /lsp install zig.",
  lua: "Install reviewed Lua Language Server 3.19.1, then rerun /lsp install lua.",
};

export async function installLanguageServer(
  languageOrKey: string,
  onProgress?: (msg: string) => void,
): Promise<InstallResult> {
  const norm = languageOrKey.toLowerCase().trim();
  ensureLspBinDir();

  const manual = MANUAL_INSTALLS[norm];
  if (manual) return { success: false, message: manual };

  const specs = getInstallerSpecs()[norm];
  if (!specs || specs.length === 0) {
    const hint = LSP_SERVERS[norm]?.installHint;
    return {
      success: false,
      message: `No pinned automated installer is available${hint ? `. Manual option: ${hint}` : "."}`,
    };
  }

  let lastFailure = "No installer attempted";
  for (const spec of specs) {
    onProgress?.(`Installing ${spec.label} with trusted ${spec.command}...`);
    const result = executeInstallerSpec(spec);
    if (result.success) return result;
    lastFailure = result.message;
    kernelDebug(result.message);
  }
  return { success: false, message: lastFailure };
}
