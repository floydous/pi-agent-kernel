import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { exec, execSync } from "node:child_process";
import {
  PI_LSP_BIN_DIR,
  LSP_SERVERS,
  clearExecutableCache,
  findExecutable,
} from "./lsp_registry";
import { kernelDebug } from "../safety/kernel_debug";

/**
 * Ensure ~/.pi/lsp/bin directory exists
 */
export function ensureLspBinDir(): string {
  if (!fs.existsSync(PI_LSP_BIN_DIR)) {
    fs.mkdirSync(PI_LSP_BIN_DIR, { recursive: true });
  }
  return PI_LSP_BIN_DIR;
}

export interface InstallResult {
  success: boolean;
  message: string;
  binPath?: string;
}

/**
 * Install language server via npm, uv, cargo, or binary release
 */
export async function installLanguageServer(
  languageOrKey: string,
  onProgress?: (msg: string) => void,
): Promise<InstallResult> {
  const norm = languageOrKey.toLowerCase().trim();
  ensureLspBinDir();

  onProgress?.(`Resolving server installer for '${norm}'...`);

  // TypeScript / JavaScript: Install @vtsls/language-server + typescript
  if (
    norm === "typescript" ||
    norm === "ts" ||
    norm === "javascript" ||
    norm === "js"
  ) {
    onProgress?.("Installing @vtsls/language-server & typescript via npm...");
    try {
      execSync(`npm install -g @vtsls/language-server typescript`, {
        stdio: "pipe",
      });
      clearExecutableCache();
      const bin = findExecutable("vtsls");
      return {
        success: true,
        message: `Successfully installed vtsls (${bin || "vtsls"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install vtsls: ${e.message}`,
      };
    }
  }

  // Python: Install Astral ty or pyright
  if (norm === "python" || norm === "py") {
    // Try uv first if available
    const uvBin = findExecutable("uv");
    if (uvBin) {
      onProgress?.("Installing Astral 'ty' via uv...");
      try {
        execSync(`uv tool install ty`, { stdio: "pipe" });
        clearExecutableCache();
        const bin = findExecutable("ty");
        if (bin) {
          return {
            success: true,
            message: `Successfully installed Astral ty (${bin})`,
            binPath: bin,
          };
        }
      } catch (e) {
        kernelDebug(e);
      }
    }

    // Fall back to pyright via npm
    onProgress?.("Installing pyright via npm...");
    try {
      execSync(`npm install -g pyright`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("pyright-langserver");
      return {
        success: true,
        message: `Successfully installed pyright (${bin || "pyright-langserver"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install python LSP: ${e.message}`,
      };
    }
  }

  // Rust: rust-analyzer via rustup
  if (norm === "rust" || norm === "rs") {
    onProgress?.("Installing rust-analyzer via rustup...");
    try {
      execSync(`rustup component add rust-analyzer`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("rust-analyzer");
      return {
        success: true,
        message: `Successfully installed rust-analyzer (${bin || "rust-analyzer"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install rust-analyzer: ${e.message}`,
      };
    }
  }

  // Go: gopls
  if (norm === "go" || norm === "golang") {
    onProgress?.("Installing gopls via go install...");
    try {
      execSync(`go install golang.org/x/tools/gopls@latest`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("gopls");
      return {
        success: true,
        message: `Successfully installed gopls (${bin || "gopls"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install gopls: ${e.message}`,
      };
    }
  }

  // TOML: taplo
  if (norm === "toml" || norm === "taplo") {
    onProgress?.("Installing taplo-cli via cargo...");
    try {
      execSync(`cargo install taplo-cli --locked --features lsp`, {
        stdio: "pipe",
      });
      clearExecutableCache();
      const bin = findExecutable("taplo");
      return {
        success: true,
        message: `Successfully installed taplo (${bin || "taplo"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install taplo: ${e.message}`,
      };
    }
  }

  // Shell / Bash: bash-language-server via npm
  if (norm === "shell" || norm === "bash" || norm === "sh") {
    onProgress?.("Installing bash-language-server via npm...");
    try {
      execSync(`npm install -g bash-language-server`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("bash-language-server");
      return {
        success: true,
        message: `Successfully installed bash-language-server (${bin || "bash-language-server"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install bash-language-server: ${e.message}`,
      };
    }
  }

  // HTML: superhtml or vscode-html-language-server
  if (norm === "html" || norm === "htm") {
    onProgress?.("Installing superhtml via package manager...");
    const isWindows = process.platform === "win32";
    try {
      if (isWindows) {
        execSync(
          `winget install kristoff-it.superhtml --accept-source-agreements --accept-package-agreements --silent`,
          { stdio: "pipe" },
        );
      } else if (process.platform === "darwin") {
        execSync(`brew install superhtml`, { stdio: "pipe" });
      }
    } catch (e) {
      kernelDebug(e);
    }

    clearExecutableCache();
    let bin = findExecutable("superhtml");
    if (bin) {
      return {
        success: true,
        message: `Successfully installed superhtml (${bin})`,
        binPath: bin,
      };
    }

    // Fallback to vscode-langservers-extracted via npm
    onProgress?.("Installing vscode-langservers-extracted via npm...");
    try {
      execSync(`npm install -g vscode-langservers-extracted`, {
        stdio: "pipe",
      });
      clearExecutableCache();
      bin = findExecutable("vscode-html-language-server");
      return {
        success: true,
        message: `Successfully installed vscode-html-language-server (${bin || "vscode-html-language-server"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install HTML LSP: ${e.message}`,
      };
    }
  }

  // JSON: Biome (Rust ultra-fast) or vscode-json-language-server
  if (norm === "json" || norm === "jsonc") {
    onProgress?.("Installing Biome (Rust) via npm...");
    try {
      execSync(`npm install -g @biomejs/biome`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("biome");
      if (bin) {
        return {
          success: true,
          message: `Successfully installed Biome (${bin})`,
          binPath: bin,
        };
      }
    } catch (e) {
      kernelDebug(e);
    }

    onProgress?.("Installing vscode-langservers-extracted via npm...");
    try {
      execSync(`npm install -g vscode-langservers-extracted`, {
        stdio: "pipe",
      });
      clearExecutableCache();
      const bin = findExecutable("vscode-json-language-server");
      return {
        success: true,
        message: `Successfully installed vscode-json-language-server (${bin || "vscode-json-language-server"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install JSON LSP: ${e.message}`,
      };
    }
  }

  // YAML: yaml-language-server via npm
  if (norm === "yaml" || norm === "yml") {
    onProgress?.("Installing yaml-language-server via npm...");
    try {
      execSync(`npm install -g yaml-language-server`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("yaml-language-server");
      return {
        success: true,
        message: `Successfully installed yaml-language-server (${bin || "yaml-language-server"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install yaml-language-server: ${e.message}`,
      };
    }
  }

  // Dockerfile: dockerfile-language-server-nodejs via npm
  if (norm === "docker" || norm === "dockerfile") {
    onProgress?.("Installing dockerfile-language-server-nodejs via npm...");
    try {
      execSync(`npm install -g dockerfile-language-server-nodejs`, {
        stdio: "pipe",
      });
      clearExecutableCache();
      const bin = findExecutable("docker-langserver");
      return {
        success: true,
        message: `Successfully installed docker-langserver (${bin || "docker-langserver"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install dockerfile-language-server: ${e.message}`,
      };
    }
  }

  // PHP: intelephense via npm
  if (norm === "php") {
    onProgress?.("Installing intelephense via npm...");
    try {
      execSync(`npm install -g intelephense`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("intelephense");
      return {
        success: true,
        message: `Successfully installed intelephense (${bin || "intelephense"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install intelephense: ${e.message}`,
      };
    }
  }

  // Markdown: marksman
  if (norm === "markdown" || norm === "md") {
    onProgress?.("Installing marksman...");
    const isWindows = process.platform === "win32";
    const binDir = ensureLspBinDir();

    // 1. Try winget / brew / package manager first
    try {
      if (isWindows) {
        execSync(
          `winget install Artempyanykh.Marksman --accept-source-agreements --accept-package-agreements --silent`,
          { stdio: "pipe" },
        );
      } else if (process.platform === "darwin") {
        execSync(`brew install marksman`, { stdio: "pipe" });
      }
    } catch (e) {
      kernelDebug(e);
    }

    clearExecutableCache();
    let bin = findExecutable("marksman");
    if (bin) {
      return {
        success: true,
        message: `Successfully installed marksman (${bin})`,
        binPath: bin,
      };
    }

    return {
      success: false,
      message:
        "Please install marksman using your system package manager (e.g. winget, brew, or cargo install marksman).",
    };
  }

  // C / C++: clangd
  if (norm === "cpp" || norm === "c" || norm === "clangd") {
    onProgress?.("Installing clangd...");
    const isWindows = process.platform === "win32";
    try {
      if (isWindows) {
        execSync(
          `winget install LLVM.clangd --accept-source-agreements --accept-package-agreements --silent`,
          { stdio: "pipe" },
        );
      } else if (process.platform === "darwin") {
        execSync(`brew install llvm`, { stdio: "pipe" });
      }
      clearExecutableCache();
      const bin = findExecutable("clangd");
      if (bin) {
        return {
          success: true,
          message: `Successfully installed clangd (${bin})`,
          binPath: bin,
        };
      }
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install clangd: ${e.message}`,
      };
    }
  }

  // Zig: zls
  if (norm === "zig" || norm === "zls") {
    onProgress?.("Installing zls...");
    const isWindows = process.platform === "win32";
    try {
      if (isWindows) {
        execSync(
          `winget install zigtools.zls --accept-source-agreements --accept-package-agreements --silent`,
          { stdio: "pipe" },
        );
      } else if (process.platform === "darwin") {
        execSync(`brew install zls`, { stdio: "pipe" });
      }
      clearExecutableCache();
      const bin = findExecutable("zls");
      if (bin) {
        return {
          success: true,
          message: `Successfully installed zls (${bin})`,
          binPath: bin,
        };
      }
    } catch (e: any) {
      return { success: false, message: `Failed to install zls: ${e.message}` };
    }
  }

  // Lua: lua-language-server
  if (norm === "lua") {
    onProgress?.("Installing lua-language-server...");
    const isWindows = process.platform === "win32";
    try {
      if (isWindows) {
        execSync(
          `winget install LuaLS.lua-language-server --accept-source-agreements --accept-package-agreements --silent`,
          { stdio: "pipe" },
        );
      } else if (process.platform === "darwin") {
        execSync(`brew install lua-language-server`, { stdio: "pipe" });
      }
      clearExecutableCache();
      const bin = findExecutable("lua-language-server");
      if (bin) {
        return {
          success: true,
          message: `Successfully installed lua-language-server (${bin})`,
          binPath: bin,
        };
      }
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install lua-language-server: ${e.message}`,
      };
    }
  }

  // Typst: tinymist
  if (norm === "typst" || norm === "tinymist") {
    onProgress?.("Installing tinymist...");
    const isWindows = process.platform === "win32";
    try {
      if (isWindows) {
        execSync(
          `winget install Myriad-Dreamin.Tinymist --accept-source-agreements --accept-package-agreements --silent`,
          { stdio: "pipe" },
        );
      } else if (process.platform === "darwin") {
        execSync(`brew install tinymist`, { stdio: "pipe" });
      } else {
        execSync(`cargo install --locked tinymist`, { stdio: "pipe" });
      }
      clearExecutableCache();
      const bin = findExecutable("tinymist");
      if (bin) {
        return {
          success: true,
          message: `Successfully installed tinymist (${bin})`,
          binPath: bin,
        };
      }
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install tinymist: ${e.message}`,
      };
    }
  }

  // C#: csharp-ls via dotnet
  if (norm === "csharp" || norm === "cs") {
    onProgress?.("Installing csharp-ls via dotnet tool...");
    try {
      execSync(`dotnet tool install -g csharp-ls`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("csharp-ls");
      return {
        success: true,
        message: `Successfully installed csharp-ls (${bin || "csharp-ls"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install csharp-ls: ${e.message}`,
      };
    }
  }

  // Ruby: ruby-lsp via gem
  if (norm === "ruby" || norm === "rb") {
    onProgress?.("Installing ruby-lsp via gem...");
    try {
      execSync(`gem install ruby-lsp`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("ruby-lsp");
      return {
        success: true,
        message: `Successfully installed ruby-lsp (${bin || "ruby-lsp"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install ruby-lsp: ${e.message}`,
      };
    }
  }

  // SQL: sqls via go
  if (norm === "sql" || norm === "sqls") {
    onProgress?.("Installing sqls via go install...");
    try {
      execSync(`go install github.com/sqls-server/sqls@latest`, {
        stdio: "pipe",
      });
      clearExecutableCache();
      const bin = findExecutable("sqls");
      return {
        success: true,
        message: `Successfully installed sqls (${bin || "sqls"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install sqls: ${e.message}`,
      };
    }
  }

  // LaTeX: texlab via cargo
  if (norm === "latex" || norm === "tex" || norm === "texlab") {
    onProgress?.("Installing texlab via cargo...");
    try {
      execSync(`cargo install --locked texlab`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("texlab");
      return {
        success: true,
        message: `Successfully installed texlab (${bin || "texlab"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install texlab: ${e.message}`,
      };
    }
  }

  // Protobuf: protols via cargo
  if (norm === "protobuf" || norm === "proto" || norm === "protols") {
    onProgress?.("Installing protols via cargo...");
    try {
      execSync(`cargo install --locked protols`, { stdio: "pipe" });
      clearExecutableCache();
      const bin = findExecutable("protols");
      return {
        success: true,
        message: `Successfully installed protols (${bin || "protols"})`,
        binPath: bin || undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to install protols: ${e.message}`,
      };
    }
  }

  const hint =
    LSP_SERVERS[norm]?.installHint ||
    "No automated installer available for this language.";
  return {
    success: false,
    message: `Manual installation required for '${norm}'. Recommended: ${hint}`,
  };
}
