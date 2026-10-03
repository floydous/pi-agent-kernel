import assert from "node:assert/strict";
import kernelExtension from "../../src/index";

export async function run(): Promise<void> {
  console.log("=== Running Extension Tool Collision Tests ===");
  const existing = [
    { name: "read", description: "other read", parameters: {}, promptGuidelines: [], sourceInfo: { path: "/other/read.ts", source: "/other/read.ts", scope: "user", origin: "top-level" } },
    { name: "ast_search", description: "other ast", parameters: {}, promptGuidelines: [], sourceInfo: { path: "/other/ast.ts", source: "/other/ast.ts", scope: "user", origin: "top-level" } },
    // Real pi shape: BUILTIN_PATH_PREFIX is "builtin:" (no angle brackets) and source === "builtin".
    { name: "write", description: "builtin write", parameters: {}, promptGuidelines: [], sourceInfo: { path: "builtin:write", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "edit", description: "builtin edit", parameters: {}, promptGuidelines: [], sourceInfo: { path: "builtin:edit", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "bash", description: "builtin bash", parameters: {}, promptGuidelines: [], sourceInfo: { path: "builtin:bash", source: "builtin", scope: "temporary", origin: "top-level" } },
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
    // Regression: pi built-ins must not be mistaken for extension collisions. A real builtin
    // "edit" is present above and the kernel must still register its own, otherwise every
    // edit silently falls through to pi's built-in implementation.
    assert.equal(
      registered.filter((name) => name === "edit").length,
      1,
      "kernel edit must register exactly once even when pi provides a built-in edit",
    );
    assert.equal(registered.includes("write"), false, "the kernel does not register write");

    const guidance = await handlers.get("before_agent_start")(
      { systemPrompt: "BASE", systemPromptOptions: { contextFiles: [] } },
      ctx,
    );
    assert.match(String(guidance.systemPrompt), /Tool Integration Notice/);
    // Assert on the collision sentence itself: both real extension collisions are listed and
    // pi's built-in edit is absent, regardless of ordering.
    const collisionList = (String(guidance.systemPrompt).match(/another extension already owns: ([^.]+)\./) || [])[1] || "";
    assert.match(collisionList, /ast_search/, "real extension collisions must be listed");
    assert.match(collisionList, /read/, "real extension collisions must be listed");
    assert.doesNotMatch(collisionList, /\bedit\b/, "pi built-ins must not be reported as collisions");
    assert.match(String(guidance.systemPrompt), /did not replace/);

    console.log("! Earlier extension tools win; builtin replacement remains explicit; guidance reports collisions!");
  } finally {
    delete process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
  }
}

if (require.main === module) {
  void run();
}
