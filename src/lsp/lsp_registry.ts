import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import type { LspServerConfig } from "./lsp_types";
import { getPiHomeDir, loadKernelConfig, saveGlobalKernelConfig } from "../config";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";

function usableDirectory(candidate: string): string | null {
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return null;
    if (!fs.statSync(candidate).isDirectory()) return null;
    fs.accessSync(candidate, fs.constants.W_OK);
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

export function getExtensionLspBinDir(): string {
  const packageDir = path.join(__dirname, "..", "..", "bin", "lsp");
  const userDir = path.join(getPiHomeDir(), "lsp", "bin");
  return usableDirectory(packageDir) || usableDirectory(userDir) || path.resolve(userDir);
}

export const PI_LSP_BIN_DIR = getExtensionLspBinDir();

export const PI_LSP_CONFIG_FILE = path.join(
  getPiHomeDir(),
  "lsp",
  "config.json",
);

/**
 * Load set of disabled server keys from hierarchical config.toml only.
 * No arbitrary ~/.pi/lsp/config.json side-effects.
 */
export function getDisabledServers(): Set<string> {
  const config = loadKernelConfig();
  return new Set<string>(
    (config.lsp.disabled_servers || []).map((s: string) => s.toLowerCase()),
  );
}

/**
 * Check if a server key is disabled by the user
 */
export function isServerDisabled(langKey: string): boolean {
  const disabled = getDisabledServers();
  return disabled.has(langKey.toLowerCase());
}

/**
 * Enable or disable a server key in memory / global config
 */
export function setServerDisabled(langKey: string, disabled: boolean): void {
  const current = getDisabledServers();
  const norm = langKey.toLowerCase();
  if (disabled) {
    current.add(norm);
  } else {
    current.delete(norm);
  }
  try {
    saveGlobalKernelConfig({
      lsp: {
        disabled_servers: Array.from(current),
      },
    });
  } catch (e) {
    kernelDebug(e);
  }
  // Remove legacy config.json if it exists to avoid desync
  try {
    if (fs.existsSync(PI_LSP_CONFIG_FILE)) {
      fs.unlinkSync(PI_LSP_CONFIG_FILE);
    }
  } catch (e) {
    kernelDebug(e);
  }
}

/**
 * Toggle a server's disabled state (returns true if now enabled, false if disabled)
 */
export function toggleServerEnabled(langKey: string): boolean {
  const currentlyDisabled = isServerDisabled(langKey);
  setServerDisabled(langKey, !currentlyDisabled);
  return currentlyDisabled; // if it was disabled, it is now enabled (true)
}

export const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    languageId: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    markers: ["tsconfig.json", "jsconfig.json", "package.json"],
    commands: [
      { bin: "vtsls", args: ["--stdio"] },
      { bin: "typescript-language-server", args: ["--stdio"] },
      { bin: "oxc_language_server", args: [] },
      { bin: "biome", args: ["lsp-proxy"] },
    ],
    installHint: "Run /lsp install typescript (pins vtsls 0.3.0 and TypeScript 7.0.2)",
  },
  python: {
    languageId: "python",
    extensions: [".py", ".pyi"],
    markers: [
      "pyproject.toml",
      "setup.py",
      "requirements.txt",
      "Pipfile",
      "pyrightconfig.json",
      "ty.toml",
    ],
    commands: [
      { bin: "ty", args: ["server"] },
      { bin: "basedpyright-langserver", args: ["--stdio"] },
      { bin: "pyright-langserver", args: ["--stdio"] },
      { bin: "ruff", args: ["server"] },
      { bin: "pylyzer", args: ["--server"] },
      { bin: "pylsp", args: [] },
    ],
    installHint: "Run /lsp install python (pins ty 0.0.83 with Pyright 1.1.414 fallback)",
  },
  rust: {
    languageId: "rust",
    extensions: [".rs"],
    markers: ["Cargo.toml", "Cargo.lock"],
    commands: [{ bin: "rust-analyzer", args: [] }],
    installHint: "Install rust-analyzer through a reviewed rustup toolchain, then run /lsp install rust",
  },
  go: {
    languageId: "go",
    extensions: [".go"],
    markers: ["go.mod", "go.work"],
    commands: [{ bin: "gopls", args: [] }],
    installHint: "Run /lsp install go (pins gopls v0.23.0)",
  },
  cpp: {
    languageId: "cpp",
    extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
    markers: ["compile_commands.json", "CMakeLists.txt", ".clangd"],
    commands: [{ bin: "clangd", args: ["--background-index", "--clang-tidy"] }],
    installHint:
      "Install reviewed LLVM/clangd 23.1.2, then run /lsp install cpp",
  },
  zig: {
    languageId: "zig",
    extensions: [".zig"],
    markers: ["build.zig"],
    commands: [{ bin: "zls", args: [] }],
    installHint: "Install reviewed ZLS 0.16.0, then run /lsp install zig",
  },
  elixir: {
    languageId: "elixir",
    extensions: [".ex", ".exs"],
    markers: ["mix.exs", "mix.lock"],
    commands: [
      { bin: "lexical", args: [] },
      { bin: "next-ls", args: ["--stdio"] },
      { bin: "elixir-ls", args: [] },
    ],
    installHint: "Install Lexical or Next-LS for Elixir",
  },
  csharp: {
    languageId: "csharp",
    extensions: [".cs"],
    markers: [".sln", ".csproj"],
    commands: [
      { bin: "Microsoft.CodeAnalysis.LanguageServer", args: [] },
      { bin: "csharp-ls", args: [] },
      { bin: "OmniSharp", args: ["-lsp"] },
    ],
    installHint: "Run /lsp install csharp (pins csharp-ls 0.28.0)",
  },
  ruby: {
    languageId: "ruby",
    extensions: [".rb", ".rake", "Gemfile"],
    markers: ["Gemfile", ".rubocop.yml"],
    commands: [
      { bin: "ruby-lsp", args: ["--stdio"] },
      { bin: "solargraph", args: ["stdio"] },
    ],
    installHint: "Run /lsp install ruby (pins ruby-lsp 0.26.11)",
  },
  lua: {
    languageId: "lua",
    extensions: [".lua"],
    markers: [".luarc.json", ".luacheckrc"],
    commands: [{ bin: "lua-language-server", args: [] }],
    installHint: "Install reviewed Lua Language Server 3.19.1, then run /lsp install lua",
  },
  java: {
    languageId: "java",
    extensions: [".java"],
    markers: ["pom.xml", "build.gradle", "settings.gradle"],
    commands: [
      { bin: "jdtls", args: [] },
      { bin: "jdt-language-server", args: [] },
    ],
    installHint: "Install Eclipse JDT Language Server (jdtls)",
  },
  kotlin: {
    languageId: "kotlin",
    extensions: [".kt", ".kts"],
    markers: ["build.gradle.kts", "build.gradle", "pom.xml"],
    commands: [
      { bin: "kotlin-lsp", args: [] },
      { bin: "kotlin-language-server", args: [] },
    ],
    installHint: "Install JetBrains kotlin-lsp or kotlin-language-server",
  },
  swift: {
    languageId: "swift",
    extensions: [".swift"],
    markers: ["Package.swift"],
    commands: [{ bin: "sourcekit-lsp", args: [] }],
    installHint: "Included with official Swift toolchain / Xcode",
  },
  php: {
    languageId: "php",
    extensions: [".php"],
    markers: ["composer.json"],
    commands: [
      { bin: "intelephense", args: ["--stdio"] },
      { bin: "phpactor", args: ["language-server"] },
    ],
    installHint: "Run /lsp install php (pins Intelephense 1.18.5)",
  },
  shell: {
    languageId: "shellscript",
    extensions: [".sh", ".bash", ".zsh"],
    markers: [".shellcheckrc"],
    commands: [{ bin: "bash-language-server", args: ["start"] }],
    installHint: "Run /lsp install shell (pins bash-language-server 5.8.1)",
  },
  typst: {
    languageId: "typst",
    extensions: [".typ"],
    markers: [],
    commands: [{ bin: "tinymist", args: [] }],
    installHint: "Run /lsp install typst (pins Tinymist 0.15.2)",
  },
  latex: {
    languageId: "latex",
    extensions: [".tex", ".latex", ".bib"],
    markers: [".latexmkrc", "latexmkrc"],
    commands: [{ bin: "texlab", args: [] }],
    installHint: "Run /lsp install latex (pins Texlab 4.3.2)",
  },
  markdown: {
    languageId: "markdown",
    extensions: [".md", ".markdown"],
    markers: [".marksman.toml", ".obsidian"],
    commands: [
      { bin: "marksman", args: ["server"] },
      { bin: "markdown-oxide", args: [] },
    ],
    installHint:
      "Install reviewed Marksman 2026-02-08, then run /lsp install markdown",
  },
  protobuf: {
    languageId: "proto",
    extensions: [".proto"],
    markers: ["buf.yaml", "buf.gen.yaml"],
    commands: [
      { bin: "protols", args: [] },
      { bin: "buf", args: ["beta", "lsp"] },
    ],
    installHint: "Run /lsp install protobuf (pins Protols 0.14.1)",
  },
  sql: {
    languageId: "sql",
    extensions: [".sql"],
    markers: [".sqruff", ".sqls.yml"],
    commands: [
      { bin: "sqruff", args: ["lsp"] },
      { bin: "sqls", args: [] },
      { bin: "sql-language-server", args: ["up", "--method", "stdio"] },
    ],
    installHint:
      "Run /lsp install sql (pins sqls v0.2.48)",
  },
  nix: {
    languageId: "nix",
    extensions: [".nix"],
    markers: ["flake.nix", "default.nix"],
    commands: [
      { bin: "nixd", args: [] },
      { bin: "nil", args: [] },
    ],
    installHint: "nix profile install nixpkgs#nixd",
  },
  html: {
    languageId: "html",
    extensions: [".html", ".htm"],
    markers: ["package.json", "index.html"],
    commands: [
      { bin: "superhtml", args: ["lsp"] },
      { bin: "vscode-html-language-server", args: ["--stdio"] },
    ],
    installHint:
      "Run /lsp install html (pins vscode-langservers-extracted 4.10.0)",
  },
  json: {
    languageId: "json",
    extensions: [".json", ".jsonc"],
    markers: ["package.json", "tsconfig.json"],
    commands: [
      { bin: "biome", args: ["lsp-proxy"] },
      { bin: "vscode-json-language-server", args: ["--stdio"] },
    ],
    installHint:
      "Run /lsp install json (pins Biome 2.5.14 with vscode fallback)",
  },
  yaml: {
    languageId: "yaml",
    extensions: [".yaml", ".yml"],
    markers: [],
    commands: [{ bin: "yaml-language-server", args: ["--stdio"] }],
    installHint: "Run /lsp install yaml (pins yaml-language-server 1.24.0)",
  },
  toml: {
    languageId: "toml",
    extensions: [".toml"],
    markers: ["Cargo.toml", "pyproject.toml"],
    commands: [{ bin: "taplo", args: ["lsp", "stdio"] }],
    installHint: "Run /lsp install toml (pins Taplo CLI 0.10.0)",
  },
  docker: {
    languageId: "dockerfile",
    extensions: ["Dockerfile", ".dockerfile"],
    markers: ["Dockerfile", "compose.yaml", "docker-compose.yml"],
    commands: [{ bin: "docker-langserver", args: ["--stdio"] }],
    installHint: "Run /lsp install docker (pins dockerfile-language-server-nodejs 0.15.0)",
  },
  terraform: {
    languageId: "terraform",
    extensions: [".tf", ".tfvars"],
    markers: [".terraform", "main.tf"],
    commands: [
      { bin: "terraform-ls", args: ["serve"] },
      { bin: "tofu-ls", args: ["serve"] },
    ],
    installHint: "Install terraform-ls or tofu-ls",
  },
};

/**
 * Cache for resolved executables to avoid redundant subprocess spawning
 */
const executableCache = new Map<string, string | null>();

function isBinaryUsable(fullPath: string, binName: string): boolean {
  // Special check for Rustup shims: ~/.cargo/bin contains shims that exist on disk
  // but fail to execute if the component was never installed in the active toolchain.
  if (binName === "rust-analyzer") {
    try {
      execFileSync(fullPath, ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 1500,
      });
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Check if an executable exists in system PATH or ~/.pi/lsp/bin
 */
function canonicalDirectory(directory: string): string | null {
  try {
    return fs.realpathSync(path.resolve(directory));
  } catch {
    return null;
  }
}

function pathContains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isForbiddenDirectory(directory: string, forbiddenRoots: string[]): boolean {
  const canonical = canonicalDirectory(directory);
  if (!canonical) return true;
  return forbiddenRoots.some((root) => {
    const forbidden = canonicalDirectory(root);
    return forbidden ? pathContains(forbidden, canonical) : false;
  });
}

export function findExecutable(
  binName: string,
  extraDirs: string[] = [],
  forbiddenRoots: string[] = [],
): string | null {
  const cacheKey = JSON.stringify([
    binName,
    extraDirs.map((dir) => path.resolve(dir)),
    forbiddenRoots.map((dir) => path.resolve(dir)),
    process.platform,
  ]);
  if (executableCache.has(cacheKey)) {
    return executableCache.get(cacheKey) || null;
  }

  const isWindows = process.platform === "win32";
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const legacyUserLspBin = path.join(getPiHomeDir(), "lsp", "bin");
  const searchDirs = [
    PI_LSP_BIN_DIR,
    legacyUserLspBin,
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links"),
    ...extraDirs,
  ];

  // On Windows, also include user WinGet Package directories if present
  if (isWindows) {
    const wingetPackages = path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Packages");
    if (fs.existsSync(wingetPackages)) {
      try {
        const pkgDirs = fs.readdirSync(wingetPackages, { withFileTypes: true });
        for (const pkg of pkgDirs) {
          if (pkg.isDirectory()) {
            const pkgPath = path.join(wingetPackages, pkg.name);
            searchDirs.push(pkgPath);
            // Search immediate subdirectories (e.g. clangd_22.1.6/bin or bin/)
            try {
              const subDirs = fs.readdirSync(pkgPath, { withFileTypes: true });
              for (const sub of subDirs) {
                if (sub.isDirectory()) {
                  searchDirs.push(path.join(pkgPath, sub.name));
                  const nestedBin = path.join(pkgPath, sub.name, "bin");
                  if (fs.existsSync(nestedBin)) {
                    searchDirs.push(nestedBin);
                  }
                }
              }
            } catch (e) {
              kernelDebug(e);
            }
          }
        }
      } catch (e) {
        kernelDebug(e);
      }
    }
  }

  // 1. Direct path check in extraDirs and ~/.pi/lsp/bin
  for (const dir of searchDirs) {
    if (!dir || !fs.existsSync(dir) || isForbiddenDirectory(dir, forbiddenRoots)) continue;
    const candidates = isWindows
      ? [`${binName}.cmd`, `${binName}.exe`, `${binName}.bat`, binName]
      : [binName];

    for (const cand of candidates) {
      const fullPath = path.join(dir, cand);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          if (!isBinaryUsable(fullPath, binName)) {
            continue;
          }
          executableCache.set(cacheKey, fullPath);
          return fullPath;
        }
      } catch (e) {
        kernelDebug(e);
      }
    }
  }

  // 2. System PATH lookup without shell execution
  const pathEnv = process.env.PATH || process.env.Path || "";
  const pathDirs = pathEnv.split(path.delimiter).map((d) => d.trim()).filter(Boolean);

  const pathext = (isWindows ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD") : "")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  for (const dir of pathDirs) {
    if (!dir || !fs.existsSync(dir) || isForbiddenDirectory(dir, forbiddenRoots)) continue;
    const candidates = isWindows
      ? [
          ...pathext.map((ext) => `${binName}${ext}`),
          `${binName}.cmd`,
          `${binName}.exe`,
          `${binName}.bat`,
          binName,
        ]
      : [binName];

    for (const cand of candidates) {
      const fullPath = path.join(dir, cand);
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            if (!isBinaryUsable(fullPath, binName)) {
              continue;
            }
            executableCache.set(cacheKey, fullPath);
            return fullPath;
          }
        }
      } catch (e) {
        kernelDebug(e);
      }
    }
  }

  executableCache.set(cacheKey, null);
  return null;
}

/**
 * Clear the executable cache (useful after installing a new server)
 */
export function clearExecutableCache(): void {
  executableCache.clear();
}

/**
 * Resolve the best installed LSP server command for a given language or file extension
 */
export function resolveLspServer(
  languageOrExt: string,
  extraDirs: string[] = [],
  forbiddenRoots: string[] = [],
): {
  binPath: string;
  command: string;
  args: string[];
  languageId: string;
  configKey: string;
} | null {
  const norm = languageOrExt.toLowerCase();

  // Find matching config key
  let configKey: string | null = null;
  let config: LspServerConfig | null = null;

  if (LSP_SERVERS[norm]) {
    configKey = norm;
    config = LSP_SERVERS[norm];
  } else {
    for (const [key, cfg] of Object.entries(LSP_SERVERS)) {
      if (
        cfg.languageId.toLowerCase() === norm ||
        cfg.extensions.some(
          (ext) =>
            ext.toLowerCase() === norm || norm.endsWith(ext.toLowerCase()),
        )
      ) {
        configKey = key;
        config = cfg;
        break;
      }
    }
  }

  if (!config || !configKey) return null;

  // Check if disabled by user preference
  if (isServerDisabled(configKey)) {
    return null;
  }

  // Try each configured command in priority order
  for (const cmd of config.commands) {
    const binPath = findExecutable(cmd.bin, extraDirs, forbiddenRoots);
    if (binPath) {
      return {
        binPath,
        command: cmd.bin,
        args: cmd.args,
        languageId: config.languageId,
        configKey,
      };
    }
  }

  return null;
}
