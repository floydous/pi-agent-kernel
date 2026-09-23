import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import assert from "node:assert";
import { walkWorkspaceFiles, isPathIgnored, DEFAULT_IGNORED_DIRS, type IgnoreFrame } from "../../src/retrieval/workspace_walker";
import { findChunkableFiles, SUPPORTED_EXTENSIONS } from "../../src/retrieval/search_chunker";
import { findSourceFiles } from "../../src/retrieval/repomap";
import { findSymbolReferences, searchAstSymbols } from "../../src/retrieval/ast_search";
import ignore from "ignore";

export async function run(): Promise<void> {
	console.log("=== Running Gitignore & Workspace Traversal Test Suite ===");

	// 1. Direct unit test on IgnoreFrame stack precedence
	const rootIg = (typeof ignore === "function" ? ignore() : (ignore as any).default())
		.add(["*.tmp", "!important.log", "ignored-dir/", "pattern-dir/*", "!pattern-dir/keep.ts"]);
	const childIg = (typeof ignore === "function" ? ignore() : (ignore as any).default())
		.add(["!keep.tmp", "*.log"]);

	const stack: IgnoreFrame[] = [
		{ dirRel: "", ig: rootIg },
		{ dirRel: "sub", ig: childIg },
	];

	// Case 1: Parent-positive / child-negative
	assert.strictEqual(
		isPathIgnored(stack, "sub/keep.tmp", false),
		false,
		"Child negation (!keep.tmp) should un-ignore file excluded by parent *.tmp",
	);
	assert.strictEqual(
		isPathIgnored(stack, "sub/drop.tmp", false),
		true,
		"Sibling file in child directory should remain ignored by parent *.tmp",
	);

	// Case 2: Parent-negative / child-positive
	assert.strictEqual(
		isPathIgnored(stack, "sub/important.log", false),
		true,
		"Child positive (*.log) should override parent negation (!important.log)",
	);

	// Case 3: Wildcard directory pattern (pattern-dir/*) with child file negation (!pattern-dir/keep.ts)
	assert.strictEqual(
		isPathIgnored(stack, "pattern-dir", true),
		false,
		"Directory pattern-dir itself must not be ignored when rule is pattern-dir/*",
	);
	assert.strictEqual(
		isPathIgnored(stack, "pattern-dir/keep.ts", false),
		false,
		"pattern-dir/keep.ts should be unignored by !pattern-dir/keep.ts",
	);
	assert.strictEqual(
		isPathIgnored(stack, "pattern-dir/drop.ts", false),
		true,
		"pattern-dir/drop.ts should be ignored by pattern-dir/*",
	);
	console.log("  ✓ Nested ignore stack: child-negative, child-positive, and wildcard descend precedence verified");

	// 2. Comprehensive filesystem traversal test with supported source files (.ts)
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-traversal-deep-"));
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-outside-dir-"));

	try {
		// Initialize git repository for differential testing against `git check-ignore --no-index`
		try {
			cp.execSync("git init", { cwd: tempDir, stdio: "ignore" });
		} catch {
			// git may not be installed in all test environments
		}

		// Directory structure setup
		fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "ignored-dir"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "pattern-dir"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "sub", "temp"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "custom", "dataset"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "agent-kernel-benchmark", "cache"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pytest_cache"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });

		// External directory file to test symlink containment
		fs.writeFileSync(path.join(outsideDir, "external.ts"), "export const ext = 1;");
		try {
			fs.symlinkSync(outsideDir, path.join(tempDir, "symlinked-external"), "junction");
		} catch {
			// Symlink creation might require privileges on Windows; skip if unsupported
		}

		// Root .gitignore
		fs.writeFileSync(
			path.join(tempDir, ".gitignore"),
			[
				"*.gen.ts",
				"!important.gen.ts",
				"ignored-dir/",
				"pattern-dir/*",
				"!pattern-dir/keep.ts",
				"secret.ts",
				"!node_modules/",
				"!agent-kernel-benchmark/",
			].join("\n"),
		);

		// Nested sub/.gitignore
		// - !keep.gen.ts un-ignores child file excluded by root *.gen.ts
		// - important.gen.ts explicitly ignores file unignored by root !important.gen.ts
		fs.writeFileSync(
			path.join(tempDir, "sub", ".gitignore"),
			[
				"!keep.gen.ts",
				"important.gen.ts",
				"temp/",
			].join("\n"),
		);

		// Ignored directory nested .gitignore attempt (must not unignore parent ignored-dir/)
		fs.writeFileSync(
			path.join(tempDir, "ignored-dir", ".gitignore"),
			[
				"!leak.ts",
			].join("\n"),
		);

		// Additive .piignore in custom/
		fs.writeFileSync(
			path.join(tempDir, "custom", ".piignore"),
			[
				"dataset/",
				"!secret.ts", // Attempt to unignore gitignored secret.ts (must NOT resurrect)
			].join("\n"),
		);

		// Files
		fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const TargetValidSymbol = 1;");
		fs.writeFileSync(path.join(tempDir, "important.gen.ts"), "export const rootImportant = 1;");
		fs.writeFileSync(path.join(tempDir, "secret.ts"), "export const secret = 1;");
		fs.writeFileSync(path.join(tempDir, "pattern-dir", "keep.ts"), "export const patternKeep = 1;");
		fs.writeFileSync(path.join(tempDir, "pattern-dir", "drop.ts"), "export const patternDrop = 1;");
		fs.writeFileSync(path.join(tempDir, "sub", "keep.gen.ts"), "export const keepGen = 1;");
		fs.writeFileSync(path.join(tempDir, "sub", "drop.gen.ts"), "export const dropGen = 1;");
		fs.writeFileSync(path.join(tempDir, "sub", "important.gen.ts"), "export const subImportant = 1;");
		fs.writeFileSync(path.join(tempDir, "sub", "temp", "scratch.ts"), "export const temp = true;");
		fs.writeFileSync(path.join(tempDir, "sub", "valid.ts"), "export const TargetSubSymbol = 1;");
		fs.writeFileSync(path.join(tempDir, "ignored-dir", "leak.ts"), "export const TargetSecretSymbol = 1;");
		fs.writeFileSync(path.join(tempDir, "custom", "app.ts"), "export const app = 1;");
		fs.writeFileSync(path.join(tempDir, "custom", "secret.ts"), "export const TargetSecretSymbol = 2;");
		fs.writeFileSync(path.join(tempDir, "custom", "dataset", "big.ts"), "export const TargetSecretSymbol = 3;");
		fs.writeFileSync(path.join(tempDir, "node_modules", "pkg", "index.ts"), "nm");
		fs.writeFileSync(path.join(tempDir, "agent-kernel-benchmark", "cache", "bench.ts"), "export const TargetSecretSymbol = 4;");
		fs.writeFileSync(path.join(tempDir, ".pytest_cache", "cache.py"), "export const cache = 1;");
		fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/master");

		// Execute walker from root
		const found = walkWorkspaceFiles({
			rootDir: tempDir,
			extensions: SUPPORTED_EXTENSIONS,
		});

		const relFound = found.map((f) => path.relative(tempDir, f).replace(/\\/g, "/")).sort();

		// Expected files:
		// - custom/app.ts
		// - important.gen.ts
		// - pattern-dir/keep.ts
		// - src/index.ts
		// - sub/keep.gen.ts
		// - sub/valid.ts
		const expected = [
			"custom/app.ts",
			"important.gen.ts",
			"pattern-dir/keep.ts",
			"src/index.ts",
			"sub/keep.gen.ts",
			"sub/valid.ts",
		].sort();

		assert.deepStrictEqual(
			relFound,
			expected,
			`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(relFound)}`,
		);
		console.log("  ✓ Directory pruning, wildcard descent, and supported file negations verified across filesystem");

		// Test walking from a subdirectory: parent .gitignore rules must still be inherited
		const subFound = walkWorkspaceFiles({
			rootDir: path.join(tempDir, "sub"),
			extensions: SUPPORTED_EXTENSIONS,
		});
		const subRelFound = subFound.map((f) => path.relative(path.join(tempDir, "sub"), f).replace(/\\/g, "/")).sort();
		const expectedSub = ["keep.gen.ts", "valid.ts"].sort();
		assert.deepStrictEqual(
			subRelFound,
			expectedSub,
			`Subdirectory walk expected ${JSON.stringify(expectedSub)}, got ${JSON.stringify(subRelFound)}`,
		);
		console.log("  ✓ Subdirectory walk inherits parent .gitignore rules down to target folder");

		// Verify external symlink containment
		assert.strictEqual(
			relFound.some((f) => f.includes("external.ts")),
			false,
			"Symlinks pointing outside workspace root must never be traversed",
		);
		console.log("  ✓ Symlink and workspace containment verified");

		// 3. Differential check against native `git check-ignore --no-index` (when git available)
		let gitAvailable = false;
		try {
			cp.execSync("git --version", { stdio: "ignore" });
			gitAvailable = fs.existsSync(path.join(tempDir, ".git"));
		} catch {}

		if (gitAvailable) {
			const candidateGitFiles = [
				"src/index.ts",
				"important.gen.ts",
				"pattern-dir/keep.ts",
				"pattern-dir/drop.ts",
				"sub/keep.gen.ts",
				"sub/drop.gen.ts",
				"sub/important.gen.ts",
				"sub/temp/scratch.ts",
				"sub/valid.ts",
				"ignored-dir/leak.ts",
				"custom/app.ts",
				"custom/secret.ts",
			];

			for (const file of candidateGitFiles) {
				let gitIgnored = false;
				try {
					cp.execSync(`git check-ignore --no-index -q "${file}"`, { cwd: tempDir, stdio: "ignore" });
					gitIgnored = true;
				} catch {
					gitIgnored = false;
				}
				const walkerIncluded = relFound.includes(file);
				assert.strictEqual(
					!walkerIncluded,
					gitIgnored,
					`Discrepancy with git check-ignore --no-index for ${file}: walkerIncluded=${walkerIncluded}, gitIgnored=${gitIgnored}`,
				);
			}
			console.log("  ✓ Exact differential parity with native `git check-ignore --no-index` verified");
		}

		// Verify that custom/secret.ts was NOT resurrected by custom/.piignore
		assert.strictEqual(
			relFound.includes("custom/secret.ts"),
			false,
			".piignore negation in child directory must not resurrect a .gitignore-excluded file",
		);

		// Verify that ignored-dir was pruned and leak.ts was never visited
		assert.strictEqual(
			relFound.includes("ignored-dir/leak.ts"),
			false,
			"Ignored directory must not be entered even with child .gitignore negation",
		);

		// Verify that user negation patterns cannot resurrect hard exclusions
		assert.strictEqual(
			relFound.includes("node_modules/pkg/index.ts"),
			false,
			"User .gitignore negation must never resurrect hard exclusions (node_modules)",
		);
		assert.strictEqual(
			relFound.includes("agent-kernel-benchmark/cache/bench.ts"),
			false,
			"User .gitignore negation must never resurrect hard exclusions (agent-kernel-benchmark)",
		);
		console.log("  ✓ Hard exclusions and additive safety boundary strictly enforced");

		// 4. ast_search integration verification
		const symbolUsages = findSymbolReferences(tempDir, "TargetSecretSymbol", 10);
		assert.strictEqual(
			symbolUsages.length,
			0,
			`findSymbolReferences found symbols in ignored files: ${JSON.stringify(symbolUsages)}`,
		);

		const validUsages = findSymbolReferences(tempDir, "TargetValidSymbol", 10);
		assert.strictEqual(
			validUsages.length,
			1,
			"findSymbolReferences must find valid symbols in non-ignored files",
		);

		const astQuery = searchAstSymbols(tempDir, { name: "TargetSecretSymbol" });
		assert.strictEqual(
			astQuery.length,
			0,
			`searchAstSymbols found symbols in ignored files: ${JSON.stringify(astQuery)}`,
		);

		const validAstQuery = searchAstSymbols(tempDir, { name: "TargetValidSymbol" });
		assert.strictEqual(
			validAstQuery.length,
			1,
			"searchAstSymbols must find valid symbols in non-ignored files",
		);
		console.log("  ✓ ast_search (findSymbolReferences & searchAstSymbols) strictly respects ignore boundaries");

		// 5. Live workspace verification
		const liveFiles = findChunkableFiles(process.cwd());
		assert(liveFiles.length > 0, "Live workspace should contain chunkable files");
		const leakedBenchmarkFiles = liveFiles.filter((f) => f.includes("agent-kernel-benchmark"));
		assert.strictEqual(
			leakedBenchmarkFiles.length,
			0,
			`Benchmark files leaked into search index: ${leakedBenchmarkFiles.slice(0, 5).join(", ")}`,
		);

		const liveSourceFiles = findSourceFiles(process.cwd());
		assert(liveSourceFiles.length > 0, "Live workspace should contain source files");
		const leakedRepomapFiles = liveSourceFiles.filter((f) => f.includes("agent-kernel-benchmark"));
		assert.strictEqual(
			leakedRepomapFiles.length,
			0,
			`Benchmark files leaked into repomap: ${leakedRepomapFiles.slice(0, 5).join(", ")}`,
		);
		console.log(`  ✓ Live workspace clean: ${liveFiles.length} chunkable files, 0 leaks`);

		// 6. Test stale indexed content eviction & persistence reload across instance lifecycles
		const indexTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stale-index-test-"));
		try {
			fs.mkdirSync(path.join(indexTestDir, "src"), { recursive: true });
			fs.writeFileSync(path.join(indexTestDir, "src", "feature.ts"), "export const UniqueFeatureAlpha = 42;");
			fs.writeFileSync(path.join(indexTestDir, ".gitignore"), "# empty\n");

			const { HybridSearchIndex } = await import("../../src/retrieval/search_index");
			const { getSearchConfig } = await import("../../src/retrieval/search_config");
			const cfg = getSearchConfig("lean", indexTestDir);

			// Instance 1: Initial sync and persistent write
			const index1 = new HybridSearchIndex(indexTestDir, cfg);
			await index1.syncWorkspace(true);
			await index1.flushPendingSave(true);

			let hits1 = await index1.search("UniqueFeatureAlpha");
			assert.strictEqual(hits1.length, 1, "feature.ts must be indexed and searchable initially");

			// Now add src/feature.ts to .gitignore without restarting the process or instance
			fs.writeFileSync(path.join(indexTestDir, ".gitignore"), "src/feature.ts\n");

			// Querying index1 directly in the same active instance triggers ensureWorkspaceSnapshotFresh,
			// which detects the .gitignore change and automatically invalidates & purges stale chunks
			hits1 = await index1.search("UniqueFeatureAlpha");
			assert.strictEqual(hits1.length, 0, "feature.ts must be evicted immediately in active instance without restart");

			// Instance 2: Reload clean from disk in new instance, verify persistence was also cleaned
			await index1.flushPendingSave(true);
			const index2 = new HybridSearchIndex(indexTestDir, cfg);
			const loaded = index2.loadFromDisk();
			assert.strictEqual(loaded, true, "Index should load from persisted disk snapshot");

			const hits2 = await index2.search("UniqueFeatureAlpha");
			assert.strictEqual(hits2.length, 0, "feature.ts must remain evicted and return 0 hits in reloaded instance");

			// Confirm disk persistence also reflected the purge
			await index2.flushPendingSave(true);
			const index3 = new HybridSearchIndex(indexTestDir, cfg);
			index3.loadFromDisk();
			const status = index3.getStatus();
			assert.strictEqual(status.fileCount, 0, "Persisted index should have exactly 0 files after eviction");
			assert.strictEqual(status.chunkCount, 0, "Persisted index should have 0 chunks after eviction");
			assert.strictEqual(status.vectorCount, 0, "Persisted index should have 0 vectors after eviction");

			// Test comment-only ignore file change that affects 0 indexed files
			fs.writeFileSync(path.join(indexTestDir, ".gitignore"), "src/feature.ts\n# a harmless comment\n");
			// ensureWorkspaceSnapshotFresh must notice the ignore file change, sync without errors or phantom files
			await index3.search("NonExistentQuery");
			const statusAfterComment = index3.getStatus();
			assert.strictEqual(statusAfterComment.fileCount, 0, "File count must remain 0 after non-impacting ignore change");

			console.log("  ✓ Stale indexed content, zero phantom files, and persistence reload cleanly evicts gitignored files");
		} finally {
			fs.rmSync(indexTestDir, { recursive: true, force: true });
		}

	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(outsideDir, { recursive: true, force: true });
	}

	console.log("\n✓ All Gitignore & Workspace Traversal Tests Passed Successfully!\n");
}

if (require.main === module) {
	void run();
}
