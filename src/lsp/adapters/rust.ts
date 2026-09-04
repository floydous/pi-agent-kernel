import { BaseLspAdapter } from "./base";

export class RustLspAdapter extends BaseLspAdapter {
  constructor() {
    super("rust");
  }

  public override getInitializationOptions(_rootDir: string): Record<string, any> {
    return {
      checkOnSave: true,
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
        if (section.startsWith("rust-analyzer") || section === "") {
          return {
            check: { command: "check" },
            checkOnSave: true,
            cargo: { buildScripts: { enable: true } },
            diagnostics: { enable: true, experimental: { enable: true } },
          };
        }
        return {};
      });
    }
    return super.handleServerRequest(method, params, rootDir);
  }
}
