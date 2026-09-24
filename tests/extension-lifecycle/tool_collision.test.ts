import assert from "node:assert/strict";
import kernelExtension from "../../src/index";

export async function run(): Promise<void> {
  console.log("=== Running Extension Tool Collision Tests ===");
  const existing = [
    { name: "read", description: "other read", parameters: {}, promptGuidelines: [], sourceInfo: { path: "/other/read.ts", source: "/other/read.ts", scope: "user", origin: "top-level" } },
    { name: "ast_search", description: "other ast", parameters: {}, promptGuidelines: [], sourceInfo: { path: "/other/ast.ts", source: "/other/ast.ts", scope: "user", origin: "top-level" } },
    { name: "write", description: "builtin write", parameters: {}, promptGuidelines: [], sourceInfo: { path: "<builtin:write>", source: "builtin", scope: "user", origin: "top-level" } },
  ];
  const registered: string[] = [];
  const handlers = new Map<string, any>();
  const pi: any = {
    registerTool(tool: any) { registered.push(tool.name); },
    registerCommand() {},
    getAllTools() { return existing; },
    on(event: string, handler: any) { handlers.set(event, handler); return () => {}; },
  };

  process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS = "1";
  try {
    await kernelExtension(pi);
    const ctx: any = {
      cwd: process.cwd(),
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify() {} },
      sessionManager: { getCwd: () => process.cwd() },
    };
    await handlers.get("session_start")({}, ctx);

    assert.equal(registered.includes("read"), false, "earlier extension read must win");
    assert.equal(registered.includes("ast_search"), false, "earlier extension ast_search must win");
    for (const expected of ["edit", "code_search", "get_repo_map", "lsp"]) {
      assert.equal(registered.includes(expected), true, `${expected} should register when unclaimed`);
    }
    assert.equal(registered.includes("write"), false, "builtin write is not an extension collision");

    const guidance = await handlers.get("before_agent_start")(
      { systemPrompt: "BASE", systemPromptOptions: { contextFiles: [] } },
      ctx,
    );
    assert.match(String(guidance.systemPrompt), /Tool Integration Notice/);
    assert.match(String(guidance.systemPrompt), /ast_search, read/);
    assert.match(String(guidance.systemPrompt), /did not replace/);

    console.log("! Earlier extension tools win; builtin replacement remains explicit; guidance reports collisions!");
  } finally {
    delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
  }
}

if (require.main === module) {
  void run();
}
