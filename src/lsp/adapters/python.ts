import { BaseLspAdapter } from "./base";

export class PythonLspAdapter extends BaseLspAdapter {
  constructor() {
    super("python");
  }

  public override getInitializationOptions(_rootDir: string): Record<string, any> {
    return {
      analysis: {
        autoSearchPaths: true,
        useLibraryCodeForTypes: true,
        diagnosticMode: "openFilesOnly",
        typeCheckingMode: "basic",
      },
    };
  }

  public override handleServerRequest(method: string, params: any, rootDir: string): any {
    if (method === "workspace/configuration") {
      const items = params?.items || [];
      return items.map((item: any) => {
        const section = item?.section || "";
        if (section.startsWith("python") || section.startsWith("pyright") || section.startsWith("basedpyright")) {
          return {
            analysis: {
              diagnosticMode: "openFilesOnly",
              typeCheckingMode: "basic",
            },
          };
        }
        return null;
      });
    }
    return super.handleServerRequest(method, params, rootDir);
  }
}
