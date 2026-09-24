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

const MAX_DEFINITIONS = 200;
const MAX_REFERENCES = 200;
const MAX_REFERENCE_FILE_BYTES = 1024 * 1024;
const MAX_SYMBOLS = 100;
const MAX_SYMBOL_DEPTH = 10;
const MAX_HOVER_CHARS = 32 * 1024;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2 * 1024;

function clipText(value: unknown, limit: number): string {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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

  const visible = diagnostics.slice(0, 200);
  const lines = visible.map((d) => {
    const sev = severityLabel(d.severity);
    const line = d.range.start.line + 1; // Convert 0-indexed to 1-indexed
    const col = d.range.start.character + 1;
    const codeStr = d.code !== undefined ? ` [${d.code}]` : "";
    const srcStr = d.source ? ` (${d.source})` : "";
    return `- [${line}:${col}] [${sev}]${codeStr} ${clipText(d.message, MAX_DIAGNOSTIC_MESSAGE_CHARS)}${srcStr}`;
  });
  if (diagnostics.length > visible.length) {
    lines.push(`[Truncated: ${visible.length}/${diagnostics.length} diagnostics]`);
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

  const visible = locations.slice(0, MAX_DEFINITIONS);
  const lines = visible.map((loc) => {
    const filePath = uriToPath(loc.uri);
    const rawDisplay = cwd ? path.relative(cwd, filePath) || filePath : filePath;
    const displayPath = rawDisplay.replace(/\\/g, "/");
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    return `${displayPath}:${line}:${col}`;
  });
  if (locations.length > visible.length) {
    lines.push(`[Truncated: ${visible.length}/${locations.length} definitions]`);
  }

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
  const effectiveBudget = Math.min(4096, Math.max(budget, symLen));
  const pad = Math.max(0, effectiveBudget - symLen);
  const left = Math.max(0, s - Math.floor(pad / 2));
  const right = Math.min(normLine.length, e + Math.ceil(pad / 2));
  const snippet = normLine.slice(left, right).trim().slice(0, 4096);
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
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size <= MAX_REFERENCE_FILE_BYTES) {
          const lines = fs.readFileSync(filePath, "utf8").split("\n");
          fileLinesCache.set(filePath, lines);
          return lines;
        }
      }
    } catch {
      // Fall through to null for inaccessible/virtual files
    }
    fileLinesCache.set(filePath, null);
    return null;
  };

  const visible = references.slice(0, MAX_REFERENCES);
  const lines = visible.map((loc) => {
    const filePath = uriToPath(loc.uri);
    const rawDisplay = cwd ? path.relative(cwd, filePath) || filePath : filePath;
    const displayPath = rawDisplay.replace(/\\/g, "/");
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
  if (references.length > visible.length) {
    lines.push(`[Truncated: ${visible.length}/${references.length} references]`);
  }
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
  if (!cleanText) return "No hover information available at this position.";
  return cleanText.length > MAX_HOVER_CHARS
    ? `${cleanText.slice(0, MAX_HOVER_CHARS)}\n[Hover truncated]`
    : cleanText;
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
  let emitted = 0;
  let truncated = false;

  const renderSymbol = (s: any, depth = 0) => {
    if (emitted >= MAX_SYMBOLS || depth > MAX_SYMBOL_DEPTH) {
      truncated = true;
      return;
    }
    const indent = "  ".repeat(depth);
    const kind = symbolKindLabel(s.kind);
    const range = s.range || s.location?.range;
    const line = range ? range.start.line + 1 : 1;
    const detail = s.detail ? ` (${clipText(s.detail, 500)})` : "";
    lines.push(`${indent}${line}: [${kind}] ${clipText(s.name, 200)}${detail}`);
    emitted++;

    if (s.children && Array.isArray(s.children)) {
      for (const child of s.children) renderSymbol(child, depth + 1);
    }
  };

  for (const s of symbols) {
    if (emitted >= MAX_SYMBOLS) {
      truncated = true;
      break;
    }
    renderSymbol(s, 0);
  }

  if (truncated) {
    lines.push(`[Truncated: ${emitted}/${symbols.length} symbols shown]`);
  }
  return lines.join("\n");
}
