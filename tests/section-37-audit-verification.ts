import { runSection, assertPass, logPass } from "./_setup";
import * as path from "node:path";
import * as fs from "node:fs";
import { TreeSitterEngine } from "../src/retrieval/tree_sitter_engine";
import { HybridSearchIndex } from "../src/retrieval/search_index";
import { computeRepoMap } from "../src/retrieval/repomap";
import { findExecutable } from "../src/lsp/lsp_registry";
import { getPiHomeDir } from "../src/config";

export async function run(): Promise<void> {
	await runSection("37. Post-Fix Verification Audit Suite", async () => {
		// 1. Invalidation of stale caches with different extractor generations
		const tmpDir = path.join(process.cwd(), "tmp_s37_test");
		if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
		fs.mkdirSync(tmpDir, { recursive: true });

		try {
			const cacheDir = path.join(tmpDir, ".pi", "cache", "search");
			fs.mkdirSync(cacheDir, { recursive: true });

			const tsFile = path.join(tmpDir, "calculator.ts");
			const padding = Array.from({ length: 45 }, (_, i) => `// line ${i}`).join("\n");
			fs.writeFileSync(tsFile, `export class Calc {\n  public multiply(x: number): number { return x * 2; }\n}\n${padding}\n`, "utf8");

			// Stale cache fixture with old extractor generation
			const staleCache = {
				version: 3,
				extractorGeneration: "stale-generation-v0",
				updatedAt: new Date().toISOString(),
				profile: "lean",
				vectorDim: 0,
				fileHashes: { "calculator.ts": "fake-hash" },
				chunks: [{
					id: "calculator.ts:0",
					filePath: "calculator.ts",
					startLine: 1,
					endLine: 4,
					content: "export class Calc {\n  public multiply(x: number): number { return x * 2; }\n}",
					tokenCount: 20,
					kind: "generic",
				}],
				vectorChunkIds: [],
				vectorHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			};
			fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify(staleCache, null, 2), "utf8");

			const index = new HybridSearchIndex(tmpDir, "lexical");
			const loadedStale = index.loadFromDisk();
			assertPass("Stale cache generation rejected by loadFromDisk", !loadedStale);

			await index.syncWorkspace(false);
			const hits = await index.search("multiply", { limit: 5 });
			const foundMethod = hits.find(h => h.chunk.kind === "method" && h.chunk.symbolName === "multiply");
			assertPass("Workspace auto-reindexed with accurate Tree-sitter method chunk", !!foundMethod);

			// 2. /repomap cold initialization and method rendering
			await TreeSitterEngine.getInstance().init();
			await TreeSitterEngine.getInstance().loadLanguages([".ts"]);
			const map = computeRepoMap(tmpDir, 1024);
			assertPass("Repo-map includes class", map.includes("class Calc"));
			assertPass("Repo-map includes method signature", map.includes("public multiply(x: number): number"));

			// 3. Polyglot normalization: abstract class, Go interface, Rust trait, C++ method
			const engine = TreeSitterEngine.getInstance();
			await engine.loadLanguages([".ts", ".rs", ".go", ".cpp"]);

			const tsTags = engine.extractTags("a.ts", "export abstract class Base { abstract run(): void; }");
			assertPass("Abstract class parsed as class", tsTags?.definitions.some(d => d.kind === "class" && d.name === "Base") ?? false);
			assertPass("Abstract method parsed as method", tsTags?.definitions.some(d => d.kind === "method" && d.name === "run") ?? false);

			const goTags = engine.extractTags("a.go", "package main\ntype Worker interface {\n\tWork() error\n}");
			assertPass("Go interface parsed as interface", goTags?.definitions.some(d => d.kind === "interface" && d.name === "Worker") ?? false);
			assertPass("Go interface method parsed as method", goTags?.definitions.some(d => d.kind === "method" && d.name === "Work") ?? false);

			const rsTags = engine.extractTags("a.rs", "pub trait Pipeline { fn step(&self); }");
			assertPass("Rust trait parsed as class", rsTags?.definitions.some(d => d.kind === "class" && d.name === "Pipeline") ?? false);
			assertPass("Rust trait method parsed as method", rsTags?.definitions.some(d => d.kind === "method" && d.name === "step") ?? false);

			const cppTags = engine.extractTags("a.cpp", "class Svc { public: void exec() {} };\nvoid helper() {}");
			assertPass("C++ class member parsed as method", cppTags?.definitions.some(d => d.kind === "method" && d.name === "exec") ?? false);
			assertPass("C++ non-member parsed as function", cppTags?.definitions.some(d => d.kind === "function" && d.name === "helper") ?? false);

			// 4. LSP dual directory resolution
			const userLspBin = path.join(getPiHomeDir(), "lsp", "bin");
			if (!fs.existsSync(userLspBin)) fs.mkdirSync(userLspBin, { recursive: true });
			const dummyBin = process.platform === "win32" ? "test-lsp-shim.cmd" : "test-lsp-shim";
			const dummyPath = path.join(userLspBin, dummyBin);
			fs.writeFileSync(dummyPath, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n", { mode: 0o755 });
			try {
				const resolved = findExecutable("test-lsp-shim");
				assertPass("findExecutable finds server in user legacy directory", !!resolved && resolved.includes(userLspBin));
			} finally {
				try { fs.unlinkSync(dummyPath); } catch {}
			}

			logPass("All Section 37 audit verification assertions passed!");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
