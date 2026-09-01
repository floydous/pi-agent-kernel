import { BaseLspAdapter } from "./base";
import type { LspDiagnostic } from "../lsp_types";

export class TypeScriptLspAdapter extends BaseLspAdapter {
  constructor() {
    super("typescript");
  }

  public override getInitializationOptions(_rootDir: string): Record<string, any> {
    return {
      preferences: {
        includeInlayParameterNameHints: "none",
        includeInlayVariableTypeHints: false,
        includeInlayFunctionParameterTypeHints: false,
      },
      tsserver: {
        log: "off",
        maxTsServerMemory: 4096,
      },
    };
  }

  public override handleServerRequest(method: string, params: any, rootDir: string): any {
    if (method === "workspace/configuration") {
      const items = params?.items || [];
      return items.map((item: any) => {
        const section = item?.section || "";
        if (section.startsWith("typescript") || section.startsWith("javascript") || section.startsWith("vtsls")) {
          return {};
        }
        return null;
      });
    }
    return super.handleServerRequest(method, params, rootDir);
  }

  public override transformDiagnostics(_uri: string, diagnostics: LspDiagnostic[]): LspDiagnostic[] {
    return diagnostics;
  }
}
