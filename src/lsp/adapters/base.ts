import type { LspDiagnostic } from "../lsp_types";

export interface LspAdapter {
  readonly languageKey: string;
  getInitializationOptions?(rootDir: string): Record<string, any>;
  getClientCapabilities?(): Record<string, any>;
  handleServerRequest?(method: string, params: any, rootDir: string): any;
  transformDiagnostics?(uri: string, diagnostics: LspDiagnostic[]): LspDiagnostic[];
}

export class BaseLspAdapter implements LspAdapter {
  public readonly languageKey: string;

  constructor(languageKey = "generic") {
    this.languageKey = languageKey;
  }

  public getInitializationOptions(_rootDir: string): Record<string, any> {
    return {};
  }

  public getClientCapabilities(): Record<string, any> {
    return {};
  }

  public handleServerRequest(method: string, params: any, rootDir: string): any {
    switch (method) {
      case "workspace/configuration":
        return Array.isArray(params?.items) ? params.items.map(() => null) : [];
      case "workspace/workspaceFolders":
        return [{ uri: rootDir, name: "workspace" }];
      case "workspace/applyEdit":
        return { applied: false };
      default:
        return null;
    }
  }

  public transformDiagnostics(_uri: string, diagnostics: LspDiagnostic[]): LspDiagnostic[] {
    return diagnostics;
  }
}
