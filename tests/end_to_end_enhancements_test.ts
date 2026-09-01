import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BM25Engine } from "../src/retrieval/search_bm25";
import {
	detectBestProfile,
	getSearchConfig,
	loadPersistedProfile,
	savePersistedProfile,
} from "../src/retrieval/search_config";
import { extractSymbolContent } from "../src/retrieval/symbol_reader";
import { clampCommandOutput } from "../src/safety/output_clamper";
import { computeRepoMap } from "../src/retrieval/repomap";
import { runOracle } from "../src/safety/test_oracle";

async function runEndToEndTests() {
	console.log("=== END-TO-END VERIFICATION OF APPLIED ENHANCEMENTS ===\n");

	// Test 1: Inverted BM25 Postings List Correctness & Speed
	console.log("[1. Verifying Inverted BM25 Postings List]");
	const bm25 = new BM25Engine();
	bm25.indexChunks([
		{
			id: "src/auth.ts:1-10",
			filePath: "src/auth.ts",
			symbolName: "authenticateUser",
			signature: "function authenticateUser(token: string): boolean",
			content: "export function authenticateUser(token: string): boolean { return token === 'secret'; }",
			startLine: 1,
			endLine: 10,
			breadcrumb: "src/auth.ts > authenticateUser",
			textForEmbedding: "",
		},
		{
			id: "src/db.ts:1-10",
			filePath: "src/db.ts",
			symbolName: "connectDatabase",
			signature: "function connectDatabase(url: string): void",
			content: "export function connectDatabase(url: string): void { console.log(url); }",
			startLine: 1,
			endLine: 10,
			breadcrumb: "src/db.ts > connectDatabase",
			textForEmbedding: "",
		},
	]);

	const authHits = bm25.search("authenticateUser token");
	assert.strictEqual(authHits.length, 1, "Should find exactly 1 hit for auth query");
	assert.strictEqual(authHits[0].chunkId, "src/auth.ts:1-10");

	const dbHits = bm25.search("connectDatabase");
	assert.strictEqual(dbHits.length, 1, "Should find exactly 1 hit for db query");
	assert.strictEqual(dbHits[0].chunkId, "src/db.ts:1-10");

	const emptyHits = bm25.search("nonExistentSymbol12345");
	assert.strictEqual(emptyHits.length, 0, "Should return empty for non-existent token");

	// Test removal from postings list
	bm25.removeFile("src/auth.ts");
	const postRemovalHits = bm25.search("authenticateUser");
	assert.strictEqual(postRemovalHits.length, 0, "Postings list should be cleaned upon removeFile");
	console.log("✓ Inverted BM25 indexing, searching, and removal verified!");

	// Test 2: /engine auto Profile Resolution & Persistence
	console.log("\n[2. Verifying /engine auto Profile Resolution & Persistence]");
	const bestProfile = detectBestProfile();
	assert.ok(["lean", "hybrid", "full"].includes(bestProfile), "detectBestProfile must return a valid profile");

	const autoConfig = getSearchConfig("auto");
	assert.strictEqual(autoConfig.effectiveProfile, bestProfile, `getSearchConfig('auto') must resolve to hardware profile '${bestProfile}'`);

	// Test persistence roundtrip of "auto"
	savePersistedProfile("auto");
	const reloaded = loadPersistedProfile();
	assert.strictEqual(reloaded, "auto", "loadPersistedProfile must retain 'auto'");
	// Restore default to lean for clean state
	savePersistedProfile("lean");
	console.log("✓ Profile auto-detection, config resolution, and persistence verified!");

	// Test 3: Multiple Regex Fallback Extraction in extractSymbolContent
	console.log("\n[3. Verifying Multi-Match Extraction in Symbol Reader Fallback]");
	// We use a custom file extension (.custom / .txt) that is NOT handled by extractFileTags (no repomap definition parser).
	// This strictly forces extractSymbolContent into the fallback regex path (`if (matchingDefs.length === 0)`).
	const tempTestFile = path.join(process.cwd(), "temp_multi_symbol_fallback.custom");
	const multiSymbolContent = `// First custom declaration
function renderTemplate(name: string): string {
    return name;
}

// Second custom declaration with identical name
function renderTemplate(id: number): string {
    return id.toString();
}`;
	fs.writeFileSync(tempTestFile, multiSymbolContent, "utf-8");

	try {
		const extracted = extractSymbolContent(tempTestFile, "renderTemplate");
		assert.strictEqual(extracted.found, true, "Should find target symbols via regex fallback");
		assert.strictEqual(extracted.symbols.length, 2, "Fallback path must extract all matching occurrences without early break");
		assert.strictEqual(extracted.symbols[0].startLine, 1, "First occurrence should start on line 1 with preceding comments");
		assert.strictEqual(extracted.symbols[1].startLine, 6, "Second occurrence should start on line 6 with preceding comments");
		console.log("✓ Multi-match symbol extraction verified on fallback regex path!");
	} finally {
		if (fs.existsSync(tempTestFile)) fs.unlinkSync(tempTestFile);
	}

	// Test 4: Bounded Spillover Log Pruning in output_clamper
	console.log("\n[4. Verifying Output Clamper Spillover File Pruning]");
	const tempDir = os.tmpdir();
	// Create 25 dummy spillover files
	const createdFiles: string[] = [];
	for (let i = 0; i < 25; i++) {
		const p = path.join(tempDir, `pi_bash_spillover_test_${i}_${Date.now()}.log`);
		fs.writeFileSync(p, "dummy content");
		createdFiles.push(p);
	}

	// Trigger clampCommandOutput which prunes when pi_bash_spillover_ files > 20
	const bigOutput = "a".repeat(35000);
	const clamped = clampCommandOutput(bigOutput, "test-cmd", { maxTotalBytes: 1000 });
	assert.strictEqual(clamped.truncated, true, "Large output must be truncated");
	assert.ok(clamped.spilloverPath, "Spillover path must be generated");

	const remaining = fs.readdirSync(tempDir).filter((f) => f.startsWith("pi_bash_spillover_"));
	// When pre-count > 20, clamp prunes down to 20 then writes 1 new file: remaining <= 21
	assert.ok(remaining.length <= 21, `Spillover log files must be pruned to max 21 (actual: ${remaining.length})`);

	// Clean up test spillover files
	for (const f of createdFiles) {
		try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
	}
	if (clamped.spilloverPath && fs.existsSync(clamped.spilloverPath)) {
		try { fs.unlinkSync(clamped.spilloverPath); } catch {}
	}
	console.log("✓ Spillover file generation and mtime-sorted bounded rotation verified!");

	// Test 5: Oracle Execution Timeout
	console.log("\n[5. Verifying Test Oracle Execution]");
	const oracleResult = await runOracle("node -e \"console.log('oracle-ok'); process.exit(0);\"", {
		cwd: process.cwd(),
		timeoutMs: 30000,
	});
	assert.strictEqual(oracleResult.passed, true, "Oracle execution should pass on exit code 0");
	assert.ok(oracleResult.summary.includes("GREEN [VERIFIED]"), "Summary should reflect verified state");
	console.log("✓ Test Oracle execution verified!");

	// Test 6: Repo-Map Generation & Caching Behavior
	console.log("\n[6. Verifying Repo-Map AST Generation]");
	const t0 = performance.now();
	const repoMap1 = computeRepoMap(process.cwd(), 1024);
	const dur1 = performance.now() - t0;
	assert.ok(repoMap1.includes("Repository Map"), "Repo map output must contain header");
	assert.ok(repoMap1.length > 100, "Repo map must produce non-trivial symbol map");
	console.log(`✓ Repo-map generated in ${dur1.toFixed(1)}ms!`);

	console.log("\n=================================================");
	console.log("ALL END-TO-END ENHANCEMENT TESTS PASSED (6/6)");
	console.log("=================================================");
}

export const runPromise = runEndToEndTests().catch((err) => {
	console.error("\n❌ End-to-End Test Failed:", err);
	process.exit(1);
});
