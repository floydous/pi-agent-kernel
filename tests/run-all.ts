// Runner that imports and executes each suite directory in order.
// Run with: `npx tsx tests/run-all.ts`
//
// Select a suite with `npx tsx tests/run-all.ts <suite-key>`.

async function runSuiteModule(load: () => Promise<{ run?: () => void | Promise<void> }>): Promise<void> {
	const mod = await load();
	if (typeof mod.run !== "function") {
		throw new Error("Suite entry point does not export run()");
	}
	await mod.run();
}

interface TestEntry {
	name: string;
	key: string;
	// Suite modules expose an explicit run() entry point.
	loader: () => Promise<unknown>;
}

const suites: TestEntry[] = [
	{
		name: "Tree-Sitter WASM AST Engine",
		key: "tree-sitter",
		loader: () => runSuiteModule(() => import("./tree-sitter")),
	},
	{
		name: "Cold-Process AST Extraction",
		key: "cold-process-ast",
		loader: () => runSuiteModule(() => import("./diagnostics/cold-process-reproduction")),
	},
	{
		name: "Post-Fix Verification Audit Suite",
		key: "audit-verification",
		loader: () => runSuiteModule(() => import("./audit-verification")),
	},
	{
		name: "AST Extraction",
		key: "ast-extraction",
		loader: () => runSuiteModule(() => import("./ast-extraction")),
	},
	{
		name: "Repository Map & PageRank",
		key: "repo-map",
		loader: () => runSuiteModule(() => import("./repo-map")),
	},
	{
		name: "Targeted Symbol Reader",
		key: "symbol-reader",
		loader: () => runSuiteModule(() => import("./symbol-reader")),
	},
	{
		name: "Single-Block Patching",
		key: "single-block-patch",
		loader: () => runSuiteModule(() => import("./single-block-patch")),
	},
	{
		name: "Multi-Block Patching",
		key: "multi-block-patch",
		loader: () => runSuiteModule(() => import("./multi-block-patch")),
	},
	{
		name: "Syntax Verification",
		key: "syntax-verification",
		loader: () => runSuiteModule(() => import("./syntax-verification")),
	},
	{
		name: "Session File Repair",
		key: "session-repair",
		loader: () => runSuiteModule(() => import("./session-repair")),
	},
	{
		name: "Hybrid AST Code Search",
		key: "hybrid-search",
		loader: () => runSuiteModule(() => import("./hybrid-search")),
	},
	{
		name: "Adaptive Code Search Output",
		key: "code-search-output",
		loader: () => runSuiteModule(() => import("./code-search-output")),
	},
	{
		name: "Session Benchmark Metrics",
		key: "session-benchmarks",
		loader: () => runSuiteModule(() => import("./benchmarks")),
	},
	{
		name: "Tool Output Clamping",
		key: "output-clamping",
		loader: () => runSuiteModule(() => import("./output-clamping")),
	},
	{
		name: "UI Width Safety",
		key: "ui-width-safety",
		loader: () => runSuiteModule(() => import("./ui-width-safety")),
	},
	{
		name: "Epistemic Guard",
		key: "epistemic-guard",
		loader: () => runSuiteModule(() => import("./epistemic-guard")),
	},
	{
		name: "Unified Footer",
		key: "unified-footer",
		loader: () => runSuiteModule(() => import("./unified-footer")),
	},
	{
		name: "LSP URI/Path & Detection",
		key: "lsp-uri-and-detection",
		loader: () => runSuiteModule(() => import("./lsp-uri-and-detection")),
	},
	{
		name: "LSP Formatters",
		key: "lsp-formatters",
		loader: () => runSuiteModule(() => import("./lsp-formatters")),
	},
	{
		name: "LSP Manager & Modals",
		key: "lsp-manager",
		loader: () => runSuiteModule(() => import("./lsp-manager")),
	},
	{
		name: "AST Fallback Extensions",
		key: "ast-fallback",
		loader: () => runSuiteModule(() => import("./ast-fallback")),
	},
	{
		name: "Aliased Re-exports",
		key: "aliased-re-exports",
		loader: () => runSuiteModule(() => import("./aliased-re-exports")),
	},
	{
		name: "TypeScript Full AST",
		key: "typescript-ast",
		loader: () => runSuiteModule(() => import("./typescript-ast")),
	},
	{ name: "Rust Full AST", key: "rust-ast", loader: () => runSuiteModule(() => import("./rust-ast")) },
	{
		name: "TOML Configuration",
		key: "toml-config",
		loader: () => runSuiteModule(() => import("./toml-config")),
	},
	{
		name: "Extension Lifecycle",
		key: "extension-lifecycle",
		loader: () => runSuiteModule(() => import("./extension-lifecycle")),
	},
	{
		name: "Compact Post-Edit Verification",
		key: "post-edit-verification",
		loader: () => runSuiteModule(() => import("./post-edit-verification")),
	},
	{
		name: "Cache & KV Retention Optimization",
		key: "cache-retrieval",
		loader: () => runSuiteModule(() => import("./cache-retrieval")),
	},
	{
		name: "End-to-End Enhancement Verification",
		key: "end-to-end",
		loader: () => runSuiteModule(() => import("./end-to-end")),
	},
	{
		name: "Content-Addressed Dedup",
		key: "content-dedup",
		loader: () => runSuiteModule(() => import("./content-dedup")),
	},
	{
		name: "Recall Tool Decision Logic",
		key: "recall-tool",
		loader: () => runSuiteModule(() => import("./recall-tool")),
	},
	{
		name: "End-to-End Dedup Hook Chain",
		key: "dedup-hook",
		loader: () => runSuiteModule(() => import("./dedup-hook")),
	},
	{
		name: "Epistemic Guard Mutation Continuity",
		key: "mutation-continuity",
		loader: () => runSuiteModule(() => import("./mutation-continuity")),
	},
	{
		name: "LSP Clean Diagnostics & Reference Filtering",
		key: "lsp-clean-and-filters",
		loader: () => runSuiteModule(() => import("./lsp-clean-and-filters")),
	},
	{
		name: "LSP Reference Snippets & Seam Tests",
		key: "lsp-reference-snippets",
		loader: () => runSuiteModule(() => import("./lsp-reference-snippets")),
	},
	{
		name: "Hierarchical AST Search Formatter Suite",
		key: "ast-search-formatter",
		loader: () => runSuiteModule(() => import("./ast-search-formatter")),
	},
];

async function main(): Promise<void> {
	console.log("=== Running Pi Agent Kernel Verification Suite ===\n");

	const requestedKey = process.argv[2];
	const selectedSuites = requestedKey ? suites.filter((suite) => suite.key === requestedKey) : suites;
	if (requestedKey && selectedSuites.length === 0) {
		throw new Error(`Unknown suite: ${requestedKey}`);
	}

	const startTime = Date.now();
	let passed = 0;
	let failed = 0;

	for (const entry of selectedSuites) {
		try {
			// Suite modules expose an explicit run() entry point; importing alone does not run tests.
			await entry.loader();
			passed++;
		} catch (err) {
			console.error(`\n✗ Suite '${entry.name}' threw:`, err);
			failed++;
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log("\n=================================================");
	console.log(
		`Suite complete: ${passed} passed, ${failed} failed (${elapsed}s)`,
	);
	console.log("=================================================");
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	// Final guard: if the runner itself throws, exit non-zero.
	console.error("Test execution failed:", err);
	process.exit(1);
});
