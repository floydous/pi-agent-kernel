import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";
import {
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspLocation,
  LspLocationLink,
  LspHover,
  LspDocumentSymbol,
  LspSymbolInformation,
  LspSymbolKind,
} from "./lsp_types";

/**
 * Robust cross-platform path to file:// URI conversion
 */
export function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/**
 * Robust cross-platform file:// URI to local file path conversion
 */
export function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri.replace(/^file:\/\/\/?/, "");
  }
}

/**
 * Format severity enum into concise label
 */
function severityLabel(severity?: LspDiagnosticSeverity): string {
  switch (severity) {
    case LspDiagnosticSeverity.Error:
      return "ERROR";
    case LspDiagnosticSeverity.Warning:
      return "WARN";
    case LspDiagnosticSeverity.Information:
      return "INFO";
    case LspDiagnosticSeverity.Hint:
      return "HINT";
    default:
      return "DIAG";
  }
}

/**
 * Symbol kind name lookup
 */
function symbolKindLabel(kind: LspSymbolKind): string {
  return LspSymbolKind[kind]?.toLowerCase() || "symbol";
}

/**
 * Format diagnostics into compact, token-dense text output
 */
export function formatDiagnostics(
  diagnostics: LspDiagnostic[],
  filePath?: string,
  cwd?: string
): string {
  if (!diagnostics || diagnostics.length === 0) {
    return filePath ? `No diagnostics reported for ${filePath}.` : "No diagnostics reported.";
  }

  const lines: string[] = [];
  const displayFile = filePath && cwd ? path.relative(cwd, filePath) || filePath : filePath;

  if (displayFile) {
    lines.push(`Diagnostics for ${displayFile}:`);
  }

  for (const d of diagnostics) {
    const sev = severityLabel(d.severity);
    const line = d.range.start.line + 1; // Convert 0-indexed to 1-indexed
    const col = d.range.start.character + 1;
    const codeStr = d.code !== undefined ? ` [${d.code}]` : "";
    const srcStr = d.source ? ` (${d.source})` : "";
    lines.push(`  ${line}:${col} [${sev}]${codeStr} ${d.message}${srcStr}`);
  }

  return lines.join("\n");
}

/**
 * Normalize LSP Definition / Location / LocationLink into simple LspLocation[]
 */
export function normalizeLocations(
  result: LspLocation | LspLocation[] | LspLocationLink[] | null | undefined
): LspLocation[] {
  if (!result) return [];
  if (!Array.isArray(result)) return [result];

  return result.map((item) => {
    if ("targetUri" in item) {
      // LspLocationLink
      return {
        uri: item.targetUri,
        range: item.targetSelectionRange || item.targetRange,
      };
    }
    return item;
  });
}

/**
 * Format definition or declaration locations into compact output
 */
export function formatDefinitions(
  locations: LspLocation[],
  cwd?: string
): string {
  if (!locations || locations.length === 0) {
    return "Definition not found.";
  }

  const lines = locations.map((loc) => {
    const filePath = uriToPath(loc.uri);
    const displayPath = cwd ? path.relative(cwd, filePath) || filePath : filePath;
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    return `${displayPath}:${line}:${col}`;
  });

  return `Found ${locations.length} definition(s):\n` + lines.map((l) => `  → ${l}`).join("\n");
}

/**
 * Format symbol references into compact output
 */
export function formatReferences(
  references: LspLocation[],
  cwd?: string
): string {
  if (!references || references.length === 0) {
    return "No references found.";
  }

  const lines = references.map((loc) => {
    const filePath = uriToPath(loc.uri);
    const displayPath = cwd ? path.relative(cwd, filePath) || filePath : filePath;
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    return `${displayPath}:${line}:${col}`;
  });

  return `Found ${references.length} reference(s):\n` + lines.map((l) => `  • ${l}`).join("\n");
}

/**
 * Format hover response (type signatures, markdown docstrings)
 */
export function formatHover(hover: LspHover | null | undefined): string {
  if (!hover || !hover.contents) {
    return "No hover information available at this position.";
  }

  const extractText = (content: any): string => {
    if (typeof content === "string") return content;
    if (content && typeof content === "object") {
      if ("value" in content) return content.value;
      if (Array.isArray(content)) return content.map(extractText).join("\n");
    }
    return String(content);
  };

  const rawText = extractText(hover.contents).trim();
  return rawText || "No hover information available.";
}

/**
 * Format document symbols (hierarchical or flat)
 */
export function formatDocumentSymbols(
  symbols: (LspDocumentSymbol | LspSymbolInformation)[] | null | undefined
): string {
  if (!symbols || symbols.length === 0) {
    return "No symbols found.";
  }

  const lines: string[] = [];

  const renderSymbol = (s: any, depth = 0) => {
    const indent = "  ".repeat(depth);
    const kind = symbolKindLabel(s.kind);
    const range = s.range || s.location?.range;
    const line = range ? range.start.line + 1 : 1;
    const detail = s.detail ? ` (${s.detail})` : "";
    lines.push(`${indent}• [${kind}] ${s.name}${detail} (line ${line})`);

    if (s.children && Array.isArray(s.children)) {
      for (const child of s.children) {
        renderSymbol(child, depth + 1);
      }
    }
  };

  for (const s of symbols) {
    renderSymbol(s, 0);
  }

  return lines.join("\n");
}
