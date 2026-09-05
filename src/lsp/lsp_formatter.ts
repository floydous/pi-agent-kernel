import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
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

export function normalizeUri(uri: string): string {
  try {
    let p = fileURLToPath(uri);
    if (process.platform === "win32" && /^[a-zA-Z]:/.test(p)) {
      p = p[0].toLowerCase() + p.slice(1);
    }
    const u = pathToFileURL(p).href;
    return u.replace(/^file:\/\/\/([a-zA-Z]):/, (_, letter) => "file:///" + letter.toLowerCase() + ":");
  } catch {
    return uri;
  }
}

/**
 * Robust cross-platform path to file:// URI conversion
 */
export function pathToUri(filePath: string): string {
  const abs = path.resolve(filePath);
  return normalizeUri(pathToFileURL(abs).href);
}

/**
 * Robust cross-platform file:// URI to local file path conversion
 */
export function uriToPath(uri: string): string {
  try {
    const raw = fileURLToPath(uri);
    if (process.platform === "win32" && /^[a-z]:/i.test(raw)) {
      return raw[0].toUpperCase() + raw.slice(1);
    }
    return raw;
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
  _filePath?: string,
  _cwd?: string
): string {
  if (!diagnostics || diagnostics.length === 0) {
    return "";
  }

  const lines: string[] = [];

  for (const d of diagnostics) {
    const sev = severityLabel(d.severity);
    const line = d.range.start.line + 1; // Convert 0-indexed to 1-indexed
    const col = d.range.start.character + 1;
    const codeStr = d.code !== undefined ? ` [${d.code}]` : "";
    const srcStr = d.source ? ` (${d.source})` : "";
    lines.push(`- [${line}:${col}] [${sev}]${codeStr} ${d.message}${srcStr}`);
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

  return lines.join("\n");
}

/**
 * Extract a bounded snippet around the target character span without truncating the symbol.
 */
export function windowAround(
  line: string,
  startCol0: number,
  endCol0: number,
  budget = 50
): string {
  const normLine = line.replace(/\r?\n$/, "");
  const s = Math.max(0, Math.min(startCol0, normLine.length));
  const e = Math.max(s, Math.min(endCol0, normLine.length));
  const symLen = Math.max(1, e - s);
  const effectiveBudget = Math.max(budget, symLen);
  const pad = Math.max(0, effectiveBudget - symLen);
  const left = Math.max(0, s - Math.floor(pad / 2));
  const right = Math.min(normLine.length, e + Math.ceil(pad / 2));
  const snippet = normLine.slice(left, right).trim();
  const prefix = left > 0 ? "... " : "";
  const suffix = right < normLine.length ? " ..." : "";
  return `${prefix}${snippet}${suffix}`.trim();
}

/**
 * Format symbol references into compact output with bounded line snippets.
 * Never leaks read evidence into epistemic ledger (metadata only).
 */
export function formatReferences(
  references: LspLocation[],
  cwd?: string
): string {
  if (!references || references.length === 0) {
    return "No references found.";
  }

  // Per-query line cache: read each file from disk at most once
  const fileLinesCache = new Map<string, string[] | null>();

  const getLines = (filePath: string): string[] | null => {
    if (fileLinesCache.has(filePath)) {
      return fileLinesCache.get(filePath)!;
    }
    try {
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, "utf8").split("\n");
        fileLinesCache.set(filePath, lines);
        return lines;
      }
    } catch {
      // Fall through to null for inaccessible/virtual files
    }
    fileLinesCache.set(filePath, null);
    return null;
  };

  const lines = references.map((loc) => {
    const filePath = uriToPath(loc.uri);
    const displayPath = cwd ? path.relative(cwd, filePath) || filePath : filePath;
    const line1 = loc.range.start.line + 1;
    const col1 = loc.range.start.character + 1;
    const baseLoc = `${displayPath}:${line1}:${col1}`;

    const cachedLines = getLines(filePath);
    if (!cachedLines || loc.range.start.line >= cachedLines.length) {
      return baseLoc;
    }

    const rawLine = cachedLines[loc.range.start.line] || "";
    const startCol0 = loc.range.start.character;
    const endCol0 =
      loc.range.end?.line === loc.range.start.line
        ? loc.range.end.character
        : startCol0 + 1;

    const snippet = windowAround(rawLine, startCol0, endCol0, 50);
    return snippet ? `${baseLoc}: ${snippet}` : baseLoc;
  });

  return lines.join("\n");
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
  // Strip transient LSP loading state markers (e.g. tsserver / vtsls prefixing "(loading...) ")
  const cleanText = rawText.replace(/\(loading\.\.\.\)\s*/g, "").trim();
  return cleanText || "No hover information available.";
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
    lines.push(`${indent}${line}: [${kind}] ${s.name}${detail}`);

    if (s.children && Array.isArray(s.children)) {
      for (const child of s.children) {
        renderSymbol(child, depth + 1);
      }
    }
  };

  for (const s of symbols) {
    renderSymbol(s, 0);
  }

  // Bounded output to prevent blowing context window on monolithic files
  if (lines.length > 100) {
    return lines.slice(0, 100).join("\n") + `\n\n[Truncated: 100/${lines.length} symbols shown]`;
  }

  return lines.join("\n");
}
