// Section 36: Polyglot Tree-Sitter WASM Engine End-to-End Suite
// Thoroughly verifies that all WASM-observed languages parse cleanly via TreeSitterEngine,
// extract their AST symbols accurately, and integrate end-to-end into searchAstSymbols
// and extractSymbolContent.

import * as fs from "node:fs";
import * as path from "node:path";
import { TreeSitterEngine } from "../src/retrieval/tree_sitter_engine";
import { extractFileTags } from "../src/retrieval/repomap";
import { searchAstSymbols } from "../src/retrieval/ast_search";
import { extractSymbolContent } from "../src/retrieval/symbol_reader";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

interface LanguageTestCase {
	lang: string;
	fileName: string;
	code: string;
	expectedSymbol: string;
	expectedKind: string;
}

const POLYGLOT_CASES: LanguageTestCase[] = [
	{
		lang: "TypeScript",
		fileName: "service.ts",
		code: `export class Guard {\n    public checkReadPrecondition(filePath: string): boolean {\n        return true;\n    }\n}`,
		expectedSymbol: "checkReadPrecondition",
		expectedKind: "method",
	},
	{
		lang: "JavaScript",
		fileName: "calc.js",
		code: `class TaxEngine {\n    computeRate(amount) {\n        return amount * 0.05;\n    }\n}`,
		expectedSymbol: "computeRate",
		expectedKind: "method",
	},
	{
		lang: "Python",
		fileName: "handler.py",
		code: `class ApiHandler:\n    def dispatch_event(self, event):\n        return event.ok()\n`,
		expectedSymbol: "dispatch_event",
		expectedKind: "method",
	},
	{
		lang: "Rust",
		fileName: "state.rs",
		code: `impl CircuitBreaker {\n    pub fn record_failure(&self) -> bool {\n        false\n    }\n}`,
		expectedSymbol: "record_failure",
		expectedKind: "method",
	},
	{
		lang: "Go",
		fileName: "server.go",
		code: `package main\n\ntype Worker struct{}\n\nfunc (w *Worker) StartJob() error {\n    return nil\n}`,
		expectedSymbol: "StartJob",
		expectedKind: "method",
	},
	{
		lang: "C",
		fileName: "buffer.c",
		code: `int parse_packet(char *data, int len) {\n    return len > 0;\n}`,
		expectedSymbol: "parse_packet",
		expectedKind: "function",
	},
	{
		lang: "Cpp",
		fileName: "tokenizer.cpp",
		code: `class Tokenizer {\n    void tokenize_stream() {}\n};`,
		expectedSymbol: "Tokenizer",
		expectedKind: "class",
	},
	{
		lang: "Java",
		fileName: "OrderService.java",
		code: `public class OrderService {\n    public OrderService() {}\n}`,
		expectedSymbol: "OrderService",
		expectedKind: "class",
	},
	{
		lang: "Bash",
		fileName: "deploy.sh",
		code: `function restart_cluster() {\n    echo "cluster restarting"\n}`,
		expectedSymbol: "restart_cluster",
		expectedKind: "function",
	},
	{
		lang: "Ruby",
		fileName: "worker.rb",
		code: `class JobQueue\n    def process_item\n        true\n    end\nend`,
		expectedSymbol: "process_item",
		expectedKind: "method",
	},
	{
		lang: "PHP",
		fileName: "router.php",
		code: `<?php\nclass AppRouter {\n    public function matchRoute() {}\n}`,
		expectedSymbol: "matchRoute",
		expectedKind: "method",
	},
];

async function main(): Promise<void> {
	await runSection("36. Polyglot Tree-Sitter WASM Engine End-to-End Suite", async () => {
		const ws = createTestWorkspace();
		try {
			const engine = TreeSitterEngine.getInstance();
			const initSuccess = await engine.init();
			assertPass("TreeSitterEngine polyglot initialization", initSuccess);
			logPass(`TreeSitterEngine initialized with ${engine.getSupportedExtensions().length} active parsers!`);

			for (const testCase of POLYGLOT_CASES) {
				const fullPath = path.join(ws.tempDir, testCase.fileName);
				fs.writeFileSync(fullPath, testCase.code, "utf8");

				// 1. Verify extractFileTags
				const tags = extractFileTags(fullPath, testCase.code);
				const tagDef = tags.definitions.find((d) => d.name === testCase.expectedSymbol);
				assertPass(
					`[${testCase.lang}] extractFileTags finds ${testCase.expectedSymbol}`,
					!!tagDef && tagDef.kind === testCase.expectedKind,
					{ expected: testCase.expectedSymbol, tagDef, definitions: tags.definitions }
				);

				// 2. Verify searchAstSymbols across workspace
				const searchHits = searchAstSymbols(ws.tempDir, {
					name: testCase.expectedSymbol,
					exactMatch: true,
				});
				assertPass(
					`[${testCase.lang}] searchAstSymbols resolves ${testCase.expectedSymbol}`,
					searchHits.length >= 1 && searchHits.some((h) => h.name === testCase.expectedSymbol),
					{ searchHits }
				);

				// 3. Verify extractSymbolContent
				const symResult = extractSymbolContent(fullPath, testCase.expectedSymbol);
				assertPass(
					`[${testCase.lang}] extractSymbolContent extracts ${testCase.expectedSymbol}`,
					symResult.found && symResult.symbols.length >= 1,
					{ symResult }
				);
				logPass(`[${testCase.lang}] ${testCase.expectedSymbol} (${testCase.expectedKind}) verified end-to-end!`);
			}
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
