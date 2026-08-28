/**
 * Minimal, zero-dependency Language Server Protocol (LSP 3.17) Types
 */

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export enum LspDiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface LspDiagnosticRelatedInformation {
  location: LspLocation;
  message: string;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: LspDiagnosticSeverity;
  code?: number | string;
  source?: string;
  message: string;
  relatedInformation?: LspDiagnosticRelatedInformation[];
}

export enum LspSymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

export interface LspSymbolInformation {
  name: string;
  kind: LspSymbolKind;
  tags?: number[];
  location: LspLocation;
  containerName?: string;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: LspSymbolKind;
  tags?: number[];
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspMarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface LspHover {
  contents: LspMarkupContent | string | Array<LspMarkupContent | string>;
  range?: LspRange;
}

export interface LspServerCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

export interface LspServerConfig {
  languageId: string;
  extensions: string[];
  markers: string[];
  commands: LspServerCommand[];
  installHint?: string;
}

export type LspClientState = "stopped" | "starting" | "ready" | "shutting_down" | "error";

export interface LspRequest<T = any> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: T;
}

export interface LspResponse<T = any> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface LspNotification<T = any> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}
