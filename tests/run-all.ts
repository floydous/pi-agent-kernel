// Runner that imports and executes each section-XX-*.ts file in order.
// Run with: `npx tsx tests/run-all.ts`
//
// Each test file is also independently runnable via `npx tsx tests/section-XX-*.ts`.

interface TestEntry {
	name: string;
	// Section modules execute their tests through import side effects.
	loader: () => Promise<unknown>;
}

const sections: TestEntry[] = [
	{
		name: "1. AST Extraction",
		loader: () => import("./section-01-ast-extraction"),
	},
	{
		name: "3. Repository Map & PageRank",
		loader: () => import("./section-03-repo-map"),
	},
	{
		name: "4. Targeted Symbol Reader",
		loader: () => import("./section-04-symbol-reader"),
	},
	{
		name: "5. Single-Block Patching",
		loader: () => import("./section-05-single-block-patch"),
	},
	{
		name: "6. Multi-Block Patching",
		loader: () => import("./section-06-multi-block-patch"),
	},
	{
		name: "7. Syntax Verification",
		loader: () => import("./section-07-syntax-verification"),
	},
	{
		name: "9. Session File Repair",
		loader: () => import("./section-09-session-repair"),
	},
	{
		name: "10. Hybrid AST Code Search",
		loader: () => import("./section-10-hybrid-search"),
	},
	{
		name: "11. Tool Output Clamping",
		loader: () => import("./section-11-output-clamping"),
	},
	{
		name: "12. Compaction Engine",
		loader: () => import("./section-12-compaction-engine"),
	},
	{
		name: "12.1. Compaction Prompt Caching Partitioning",
		loader: () => import("./section-12.1-compaction-prompt-caching"),
	},
	{
		name: "12.2. Bounded workspace-state extraction",
		loader: () => import("./section-12.2-workspace-state"),
	},
	{
		name: "12.3. Compaction retry logic with large input",
		loader: () => import("./section-12.3-compaction-retry-logic"),
	},
	{
		name: "13. Epistemic Guard",
		loader: () => import("./section-13-epistemic-guard"),
	},
	{ name: "14. Test Oracle", loader: () => import("./section-14-test-oracle") },
	{
		name: "15. Unified Footer",
		loader: () => import("./section-15-unified-footer"),
	},
	{
		name: "16. LSP URI/Path & Detection",
		loader: () => import("./section-16-lsp-uri-and-detection"),
	},
	{
		name: "17. LSP Formatters",
		loader: () => import("./section-17-lsp-formatters"),
	},
	{
		name: "18. LSP Manager & Modals",
		loader: () => import("./section-18-lsp-manager-modals"),
	},
	{
		name: "19. AST Fallback Extensions",
		loader: () => import("./section-19-ast-fallback-extensions"),
	},
	{
		name: "20. Aliased Re-exports",
		loader: () => import("./section-20-aliased-re-exports"),
	},
	{
		name: "21. TypeScript Full AST",
		loader: () => import("./section-21-typescript-ast"),
	},
	{ name: "22. Rust Full AST", loader: () => import("./section-22-rust-ast") },
	{
		name: "23. TOML Configuration",
		loader: () => import("./section-23-toml-config"),
	},
	{
		name: "24. Extension Lifecycle",
		loader: () => import("./section-24-extension-lifecycle"),
	},
	{
		name: "25. Compact Post-Edit Verification",
		loader: () => import("./section-25-post-edit-verification"),
	},
	{
		name: "26. Cache & KV Retention Optimization",
		loader: () => import("./intensive_cache_test"),
	},
];

async function main(): Promise<void> {
	console.log("=== Running Pi Agent Kernel Verification Suite ===\n");

	const startTime = Date.now();
	let passed = 0;
	let failed = 0;

	for (const entry of sections) {
		try {
			// Each section file runs its own main() at module load time via side effects.
			// We just need to import it; the file handles its own pass/fail and exits non-zero on failure.
			await entry.loader();
			passed++;
		} catch (err) {
			console.error(`\n✗ Section '${entry.name}' threw:`, err);
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
