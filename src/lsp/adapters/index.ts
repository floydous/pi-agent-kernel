import type { LspAdapter } from "./base";
import { BaseLspAdapter } from "./base";
import { TypeScriptLspAdapter } from "./typescript";
import { PythonLspAdapter } from "./python";
import { RustLspAdapter } from "./rust";

export * from "./base";
export * from "./typescript";
export * from "./python";
export * from "./rust";

const adapters = new Map<string, LspAdapter>([
  ["typescript", new TypeScriptLspAdapter()],
  ["python", new PythonLspAdapter()],
  ["rust", new RustLspAdapter()],
]);

export function getLspAdapter(languageKey: string): LspAdapter {
  const norm = languageKey.toLowerCase();
  return adapters.get(norm) || new BaseLspAdapter(norm);
}
