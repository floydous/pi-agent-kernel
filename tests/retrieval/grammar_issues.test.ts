import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { registerCodeSearchTool } from "../../src/tools/code_search_tool";

export async function run(): Promise<void> {
	console.log("=== Running Grammar Load Reporting Tests ===");

	console.log("1. A grammar that fails to load is recorded, and cleared once it loads...");
	const engine: any = new (TreeSitterEngine as any)();
	await engine.init();
	const realLanguage = engine.LanguageClass;
	engine.LanguageClass = { load: () => Promise.reject(new Error("bad grammar\nmore detail")) };
	await engine.loadLanguages([".rs"]);
	assert.equal(engine.getParser(".rs"), null);
	assert.deepEqual(engine.getLoadIssues(), [{ language: "rust", extensions: [".rs"], reason: "grammar failed to load: Error: bad grammar" }]);
	engine.LanguageClass = realLanguage;
	await engine.loadLanguages([".rs"]);
	assert.ok(engine.getParser(".rs"));
	assert.deepEqual(engine.getLoadIssues(), []);

	console.log("2. Index status reports issues only for languages present in the workspace...");
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-grammar-pidir-"));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-grammar-ws-"));
	process.env.PI_DIR = piDir;
	const shared = TreeSitterEngine.getInstance() as any;
	const originalIssues = shared.getLoadIssues;
	try {
		fs.writeFileSync(path.join(workspace, "main.rs"), "fn main() {}\n");
		fs.writeFileSync(path.join(workspace, "app.ts"), "export const x = 1;\n");
		const { HybridSearchIndex } = require("../../src/retrieval/search_index");
		const index = new HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await index.syncWorkspace(true);
		assert.deepEqual(index.getStatus().grammarIssues, []);
		shared.getLoadIssues = () => [
			{ language: "rust", extensions: [".rs"], reason: "grammar file tree-sitter-rust.wasm not found" },
			{ language: "go", extensions: [".go"], reason: "grammar file tree-sitter-go.wasm not found" },
		];
		assert.deepEqual(index.getStatus().grammarIssues, [{ extensions: [".rs"], reason: "grammar file tree-sitter-rust.wasm not found" }]);
		await index.flushPendingSave?.(true);
	} finally {
		shared.getLoadIssues = originalIssues;
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}

	console.log("3. code_search shows one notice when grammars are unavailable, none otherwise...");
	const hit = { chunk: { id: "main.rs:1-1", filePath: "main.rs", absolutePath: "/tmp/main.rs", startLine: 1, endLine: 1, kind: "file", symbolName: "main.rs", breadcrumb: "", content: "fn main() {}", signature: "File" }, rrfScore: 1, signal: "lexical", matches: ["main"] };
	const output = async (grammarIssues: any[]) => {
		let tool: any;
		registerCodeSearchTool({ registerTool(t: any) { tool = t; } } as any, {
			getSessionId: () => "grammar-issues",
			getSearchIndex: () => ({ search: async () => [hit], getStatus: () => ({ effectiveProfile: "lean", vectorCount: 0, chunkCount: 1, grammarIssues }) }),
		} as any);
		return (await tool.execute("g1", { query: "main" }, null, () => {}, { cwd: os.tmpdir() })).content[0].text as string;
	};
	assert.ok((await output([{ extensions: [".rs"], reason: "grammar file tree-sitter-rust.wasm not found" }]))
		.startsWith("[Notice: tree-sitter grammar unavailable for .rs (grammar file tree-sitter-rust.wasm not found); code structure for those files is approximate]"));
	assert.equal((await output([])).includes("tree-sitter grammar unavailable"), false);

	console.log("✓ Grammar load problems are recorded, scoped to the workspace, and shown in code_search output!");
}

if (require.main === module) {
	void run();
}
