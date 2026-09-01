import { BaseLspAdapter } from "./base";

export class RustLspAdapter extends BaseLspAdapter {
  constructor() {
    super("rust");
  }

  public override getInitializationOptions(_rootDir: string): Record<string, any> {
    return {
      checkOnSave: {
        command: "check",
      },
      diagnostics: {
        enable: true,
      },
    };
  }

  public override handleServerRequest(method: string, params: any, rootDir: string): any {
    if (method === "workspace/configuration") {
      const items = params?.items || [];
      return items.map((item: any) => {
        const section = item?.section || "";
        if (section.startsWith("rust-analyzer")) {
          return {
            check: { command: "check" },
            cargo: { buildScripts: { enable: true } },
          };
        }
        return null;
      });
    }
    return super.handleServerRequest(method, params, rootDir);
  }
}
