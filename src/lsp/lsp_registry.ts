import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { LspServerConfig } from "./lsp_types";
import { getPiHomeDir, loadKernelConfig } from "../config";
import { kernelDebug } from "../safety/kernel_debug";
import { writeFileSyncAtomic } from "../safety/atomic_write";

export const PI_LSP_BIN_DIR = path.join(getPiHomeDir(), "lsp", "bin");

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
      { bin: "typescript-language-server", args: ["--stdio"] },
      { bin: "vtsls", args: ["--stdio"] },
      { bin: "oxc_language_server", args: [] },
      { bin: "biome", args: ["lsp-proxy"] },
    ],
    installHint: "npm install -g typescript-language-server typescript",
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
    installHint: "uv tool install ty OR npm i -g pyright",
  },
  rust: {
    languageId: "rust",
    extensions: [".rs"],
    markers: ["Cargo.toml", "Cargo.lock"],
    commands: [{ bin: "rust-analyzer", args: [] }],
    installHint: "rustup component add rust-analyzer",
  },
  go: {
    languageId: "go",
    extensions: [".go"],
    markers: ["go.mod", "go.work"],
    commands: [{ bin: "gopls", args: [] }],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  cpp: {
    languageId: "cpp",
    extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
    markers: ["compile_commands.json", "CMakeLists.txt", ".clangd"],
    commands: [{ bin: "clangd", args: ["--background-index", "--clang-tidy"] }],
    installHint:
      "Install LLVM / Clang (brew install llvm / winget install LLVM.LLVM)",
  },
  zig: {
    languageId: "zig",
    extensions: [".zig"],
    markers: ["build.zig"],
    commands: [{ bin: "zls", args: [] }],
    installHint: "Download ZLS binary or install via zig package manager",
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
    installHint: "dotnet tool install -g csharp-ls",
  },
  ruby: {
    languageId: "ruby",
    extensions: [".rb", ".rake", "Gemfile"],
    markers: ["Gemfile", ".rubocop.yml"],
    commands: [
      { bin: "ruby-lsp", args: ["--stdio"] },
      { bin: "solargraph", args: ["stdio"] },
    ],
    installHint: "gem install ruby-lsp",
  },
  lua: {
    languageId: "lua",
    extensions: [".lua"],
    markers: [".luarc.json", ".luacheckrc"],
    commands: [{ bin: "lua-language-server", args: [] }],
    installHint: "Install lua-language-server (brew / winget / release binary)",
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
    installHint: "npm install -g intelephense",
  },
  shell: {
    languageId: "shellscript",
    extensions: [".sh", ".bash", ".zsh"],
    markers: [".shellcheckrc"],
    commands: [{ bin: "bash-language-server", args: ["start"] }],
    installHint: "npm install -g bash-language-server",
  },
  typst: {
    languageId: "typst",
    extensions: [".typ"],
    markers: [],
    commands: [{ bin: "tinymist", args: [] }],
    installHint: "cargo install --locked tinymist",
  },
  latex: {
    languageId: "latex",
    extensions: [".tex", ".latex", ".bib"],
    markers: [".latexmkrc", "latexmkrc"],
    commands: [{ bin: "texlab", args: [] }],
    installHint: "cargo install texlab",
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
      "winget install Artempyanykh.Marksman OR cargo install markdown-oxide",
  },
  protobuf: {
    languageId: "proto",
    extensions: [".proto"],
    markers: ["buf.yaml", "buf.gen.yaml"],
    commands: [
      { bin: "protols", args: [] },
      { bin: "buf", args: ["beta", "lsp"] },
    ],
    installHint: "cargo install protols OR install buf",
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
      "cargo install sqruff OR go install github.com/sqls-server/sqls@latest",
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
      "Download superhtml (Zig) or npm install -g vscode-langservers-extracted",
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
      "npm install -g @biomejs/biome OR vscode-langservers-extracted",
  },
  yaml: {
    languageId: "yaml",
    extensions: [".yaml", ".yml"],
    markers: [],
    commands: [{ bin: "yaml-language-server", args: ["--stdio"] }],
    installHint: "npm install -g yaml-language-server",
  },
  toml: {
    languageId: "toml",
    extensions: [".toml"],
    markers: ["Cargo.toml", "pyproject.toml"],
    commands: [{ bin: "taplo", args: ["lsp", "stdio"] }],
    installHint: "cargo install taplo-cli --locked --features lsp",
  },
  docker: {
    languageId: "dockerfile",
    extensions: ["Dockerfile", ".dockerfile"],
    markers: ["Dockerfile", "compose.yaml", "docker-compose.yml"],
    commands: [{ bin: "docker-langserver", args: ["--stdio"] }],
    installHint: "npm install -g dockerfile-language-server-nodejs",
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

/**
 * Check if an executable exists in system PATH or ~/.pi/lsp/bin
 */
export function findExecutable(
  binName: string,
  extraDirs: string[] = [],
): string | null {
  if (executableCache.has(binName)) {
    return executableCache.get(binName) || null;
  }

  const isWindows = process.platform === "win32";
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const searchDirs = [
    PI_LSP_BIN_DIR,
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, ".npm-global", "bin"),
    ...extraDirs,
  ];

  // 1. Direct path check in extraDirs and ~/.pi/lsp/bin
  for (const dir of searchDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const candidates = isWindows
      ? [binName, `${binName}.exe`, `${binName}.cmd`, `${binName}.bat`]
      : [binName];

    for (const cand of candidates) {
      const fullPath = path.join(dir, cand);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          executableCache.set(binName, fullPath);
          return fullPath;
        }
      } catch (e) {
        kernelDebug(e);
      }
    }
  }

  // 2. System PATH lookup via which/where
  try {
    const cmd = isWindows ? `where "${binName}"` : `which "${binName}"`;
    const stdout = execSync(cmd, {
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 800,
    });
    const matches = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && fs.existsSync(l));

    if (matches.length > 0) {
      let selected = matches[0];
      if (isWindows) {
        // On Windows, prefer .cmd / .exe / .bat over extensionless bash scripts
        const preferred = matches.find((m) =>
          [".cmd", ".exe", ".bat"].some((ext) => m.toLowerCase().endsWith(ext)),
        );
        if (preferred) selected = preferred;
      }
      executableCache.set(binName, selected);
      return selected;
    }
  } catch (e) {
    kernelDebug(e);
  }

  executableCache.set(binName, null);
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
    const binPath = findExecutable(cmd.bin, extraDirs);
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
