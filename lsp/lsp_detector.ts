import * as fs from "node:fs";
import * as path from "node:path";
import { LSP_SERVERS } from "./lsp_registry";

/**
 * Detect language identifier and root directory for a given file in workspace
 */
export function detectLanguageFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  // Exact file name matching (e.g. Dockerfile, Gemfile)
  for (const [key, cfg] of Object.entries(LSP_SERVERS)) {
    if (cfg.extensions.some((e) => e.toLowerCase() === base)) {
      return key;
    }
  }

  // Extension matching
  for (const [key, cfg] of Object.entries(LSP_SERVERS)) {
    if (cfg.extensions.some((e) => e.toLowerCase() === ext)) {
      return key;
    }
  }

  return null;
}

/**
 * Find workspace root by scanning upward for language marker files (tsconfig.json, Cargo.toml, pyproject.toml, etc.)
 */
export function findWorkspaceRoot(startDir: string, languageKey?: string): string {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  const markers = languageKey && LSP_SERVERS[languageKey]
    ? [...LSP_SERVERS[languageKey].markers, ".git"]
    : [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod"];

  while (current && current !== root) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return startDir;
}
