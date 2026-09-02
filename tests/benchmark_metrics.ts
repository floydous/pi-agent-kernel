import * as fs from "node:fs";
import * as path from "node:path";
import { computeRepoMap } from "../src/retrieval/repomap";
import { BM25Engine } from "../src/retrieval/search_bm25";
import { extractSymbolContent } from "../src/retrieval/symbol_reader";
import { applySurgicalPatch } from "../editing/patch";
import { clampCommandOutput } from "../src/safety/output_clamper";
import { checkSyntaxContent } from "../src/editing/syntax-verify";

function estimateTokens(text: string): number {
	// Standard LLM rule of thumb: ~4 characters per token
	return Math.ceil(text.length / 4);
}

async function runBenchmark() {
	console.log("==================================================");
	console.log("PI AGENT KERNEL - EMPIRICAL HARNESS BENCHMARK");
	console.log("==================================================\n");

	const cwd = process.cwd();

	// 1. Repo Map vs Raw File Tree / Full Codebase Dump
	console.log("--- 1. Context Ingestion & Repository Mapping ---");
	// Calculate total tokens of all source files in src/
	let totalRawCodeChars = 0;
	let totalSourceFiles = 0;
	function scanSrc(dir: string) {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				scanSrc(full);
			} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
				totalSourceFiles++;
				totalRawCodeChars += fs.readFileSync(full, "utf-8").length;
			}
		}
	}
	scanSrc(path.join(cwd, "src"));

	const rawCodeTokens = estimateTokens("a".repeat(totalRawCodeChars));

	const t0 = performance.now();
	const repoMap = computeRepoMap(cwd, 1024);
	const repoMapDurationMs = performance.now() - t0;
	const repoMapTokens = estimateTokens(repoMap);
	const repoMapReductionPct = ((1 - repoMapTokens / rawCodeTokens) * 100).toFixed(1);

	console.log(`Source Files Analyzed: ${totalSourceFiles}`);
	console.log(`Raw Codebase Dump: ~${rawCodeTokens} tokens`);
	console.log(`AST PageRank Repo Map: ~${repoMapTokens} tokens (Budget: 1024)`);
	console.log(`Context Token Reduction: ${repoMapReductionPct}%`);
	console.log(`Repo Map Compute Time: ${repoMapDurationMs.toFixed(2)}ms\n`);

	// 2. Surgical AST Symbol Reading vs Whole-File Reading
	console.log("--- 2. Targeted Reading vs Whole-File Dumps ---");
	const sampleFilePath = path.join(cwd, "src", "config", "kernel_config.ts");
	const fullFileContent = fs.readFileSync(sampleFilePath, "utf-8");
	const fullFileTokens = estimateTokens(fullFileContent);

	const t1 = performance.now();
	const extracted = extractSymbolContent(sampleFilePath, "loadKernelConfig");
	const symbolReadDurationMs = performance.now() - t1;
	const symbolContent = extracted.symbols.map((s) => s.content).join("\n");
	const symbolTokens = estimateTokens(symbolContent);
	const readReductionPct = ((1 - symbolTokens / fullFileTokens) * 100).toFixed(1);

	console.log(`File: src/config/kernel_config.ts (${fullFileContent.split("\n").length} lines)`);
	console.log(`Full File Read: ~${fullFileTokens} tokens`);
	console.log(`Targeted Symbol Read ('loadKernelConfig'): ~${symbolTokens} tokens`);
	console.log(`Reading Token Reduction: ${readReductionPct}%`);
	console.log(`Extraction Time: ${symbolReadDurationMs.toFixed(2)}ms\n`);

	// 3. Surgical Patching vs Whole-File Rewriting (Edit Output Tokens)
	console.log("--- 3. Mutation Strategy: Surgical Diff vs Whole-File Overwrite ---");
	// A whole-file overwrite sends the entire new file in the assistant tool call response/payload.
	// A surgical edit sends only search/replace blocks (~5-10 lines).
	const searchBlock = `export function getPiHomeDir(): string {\n\treturn path.join(os.homedir(), ".pi", "agent");\n}`;
	const replaceBlock = `export function getPiHomeDir(): string {\n\tconst custom = process.env.PI_HOME;\n\treturn custom || path.join(os.homedir(), ".pi", "agent");\n}`;
	const surgicalPayloadTokens = estimateTokens(searchBlock + replaceBlock);
	const wholeFileRewriteTokens = fullFileTokens;
	const editReductionPct = ((1 - surgicalPayloadTokens / wholeFileRewriteTokens) * 100).toFixed(1);

	console.log(`Whole-file Overwrite Output Payload: ~${wholeFileRewriteTokens} tokens`);
	console.log(`Surgical Search/Replace Payload: ~${surgicalPayloadTokens} tokens`);
	console.log(`Agent Output Token Savings per Edit: ${editReductionPct}%\n`);

	// 4. Output Clamping on Command Blowouts
	console.log("--- 4. Runaway Terminal Output Protection ---");
	const blowoutTerminalOutput = "ERROR: Failed test\n" + "    at trace.js:10:15\n".repeat(5000); // ~110k chars
	const blowoutTokens = estimateTokens(blowoutTerminalOutput);
	const clamped = clampCommandOutput(blowoutTerminalOutput, "npm test", {
		maxLines: 200,
		maxLineLength: 500,
		maxTotalBytes: 8000,
	});
	const clampedTokens = estimateTokens(clamped.text);
	const clampReductionPct = ((1 - clampedTokens / blowoutTokens) * 100).toFixed(1);

	console.log(`Unbounded Runaway Terminal Output: ~${blowoutTokens} tokens`);
	console.log(`Clamped Output (with spillover file): ~${clampedTokens} tokens`);
	console.log(`Context Blowout Protection: ${clampReductionPct}% tokens preserved\n`);

	// 5. Lexical & AST Retrieval Latency (Inverted Index)
	console.log("--- 5. Retrieval Latency & Throughput ---");
	const bm25 = new BM25Engine();
	// Index all chunks from repo
	const lines = fullFileContent.split("\n");
	const chunks = [];
	for (let i = 0; i < lines.length; i += 20) {
		const slice = lines.slice(i, i + 20).join("\n");
		chunks.push({
			id: `chunk_${i}`,
			filePath: "src/config/kernel_config.ts",
			symbolName: "config",
			signature: `chunk ${i}`,
			content: slice,
			startLine: i + 1,
			endLine: Math.min(i + 20, lines.length),
			breadcrumb: "kernel_config.ts",
			textForEmbedding: slice,
		});
	}
	bm25.indexChunks(chunks);

	const t2 = performance.now();
	for (let i = 0; i < 100; i++) {
		bm25.search("loadKernelConfig retrieval safety");
	}
	const bm25AvgDurationMs = (performance.now() - t2) / 100;
	console.log(`BM25 Index Query Latency: ${bm25AvgDurationMs.toFixed(3)}ms per query`);

	// 6. Fast Structural Syntax Gate Latency
	const t3 = performance.now();
	for (let i = 0; i < 100; i++) {
		checkSyntaxContent("test.py", "def foo():\n    return True\n");
	}
	const syntaxCheckAvgDurationMs = (performance.now() - t3) / 100;
	console.log(`Pre-commit Syntax Gate Latency (Python): ${syntaxCheckAvgDurationMs.toFixed(3)}ms per check\n`);

	console.log("==================================================");
	console.log("BENCHMARK SUMMARY:");
	console.log(`• Context Ingestion Reduction:  -${repoMapReductionPct}%`);
	console.log(`• Code Reading Token Savings:   -${readReductionPct}%`);
	console.log(`• Code Editing Token Savings:   -${editReductionPct}%`);
	console.log(`• Terminal Flood Suppression:   -${clampReductionPct}%`);
	console.log(`• Lexical Query Latency:        ${bm25AvgDurationMs.toFixed(3)}ms`);
	console.log(`• Syntax Gate Overhead:         ${syntaxCheckAvgDurationMs.toFixed(3)}ms`);
	console.log("==================================================");
}

runBenchmark().catch(console.error);
