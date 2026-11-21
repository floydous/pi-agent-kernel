import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { registerCodeSearchTool } from "../../src/tools/code_search_tool";

export async function run(): Promise<void> {
	console.log("=== Running File Pattern Notice Tests ===");
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-pattern-pidir-"));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-pattern-ws-"));
	process.env.PI_DIR = piDir;
	try {
		fs.mkdirSync(path.join(workspace, "src"));
		fs.writeFileSync(path.join(workspace, "src", "Server.ts"), "export function acceptAnthropicMessages(body: string): string {\n  return body;\n}\n");
		fs.writeFileSync(path.join(workspace, "README.md"), "Accepts OpenAI, Anthropic and Ollama protocols.\n");
		await TreeSitterEngine.getInstance().loadLanguages([".ts"]);
		const { HybridSearchIndex } = require("../../src/retrieval/search_index");
		const index = new HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await index.syncWorkspace(true);

		console.log("1. hasIndexedFile uses the file_pattern rule (case-insensitive, either slash)...");
		assert.equal(index.hasIndexedFile("server.TS"), true);
		assert.equal(index.hasIndexedFile("src\\server"), true);
		assert.equal(index.hasIndexedFile("README"), false, "Markdown is not indexed");

		let tool: any;
		registerCodeSearchTool({ registerTool(t: any) { tool = t; } } as any, {
			getSessionId: () => "file-pattern",
			getSearchIndex: () => index,
		} as any);
		const answer = async (params: Record<string, string>) =>
			(await tool.execute("f1", params, null, () => {}, { cwd: workspace })).content[0].text as string;

		console.log("2. A filter that matches no indexed file is named as the cause, not the query...");
		const filtered = await answer({ query: "OpenAI Anthropic Ollama protocols supported", file_pattern: "README" });
		assert.equal(filtered, "No indexed file path contains \"README\". code_search indexes source code only (not Markdown, JSON, YAML, TOML or other text files); use rg to search other files.");

		console.log("3. A filter that matches indexed files keeps the query tip when nothing matches...");
		const unmatched = await answer({ query: "zebra quokka", file_pattern: "src/" });
		assert.equal(unmatched, "No code chunks found matching \"zebra quokka\". (Engine: Lean [BM25 lexical]. Tips: Query with mechanism keywords or identifier patterns likely in source code; use 'rg' for exact text literals.)");
		assert.match(await answer({ query: "anthropic messages", file_pattern: "src/" }), /^src\/Server\.ts:/, "the same filter finds code");
		await index.flushPendingSave?.(true);
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(piDir, { recursive: true, force: true });
		fs.rmSync(workspace, { recursive: true, force: true });
	}
	console.log("✓ An empty answer blames a file_pattern that excludes every indexed file, and the query otherwise!");
}

if (require.main === module) {
	void run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
