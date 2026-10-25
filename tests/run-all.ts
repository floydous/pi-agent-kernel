// Runner that imports and executes each suite directory in order.
// Run with: `npx tsx tests/run-all.ts`
//
// Select a suite with `npx tsx tests/run-all.ts <suite-key>`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
		name: "Isolated Output Spillovers",
		key: "spillover-isolation",
		loader: () => runSuiteModule(() => import("./output-clamping/spillover_isolation.test")),
	},
	{
		name: "Editing Mode Contract",
		key: "editing-mode",
		loader: () => runSuiteModule(() => import("./editing/editing_mode.test")),
	},
	{
		name: "Benchmark Method Schemas & RRF Signals",
		key: "benchmark-method-rrf",
		loader: () => runSuiteModule(() => import("./editing/benchmark_method_and_rrf_test")),
	},
	{
		name: "Configuration Scope Precedence",
		key: "config-scope",
		loader: () => runSuiteModule(() => import("./toml-config/scope_precedence.test")),
	},
	{
		name: "Atomic File Metadata Safety",
		key: "atomic-metadata",
		loader: () => runSuiteModule(() => import("./safety/atomic_metadata.test")),
	},
	{
		name: "Read and Index Resource Budgets",
		key: "resource-budgets",
		loader: () => runSuiteModule(() => import("./packaging/resource_limits.test")),
	},
	{
		name: "Immutable Embedding Model Revision",
		key: "model-revision",
		loader: () => runSuiteModule(() => import("./retrieval/model_revision.test")),
	},
	{
		name: "Production Dependency Policy",
		key: "dependency-policy",
		loader: () => runSuiteModule(() => import("./packaging/dependency_policy.test")),
	},
	{
		name: "Extension Tool Collision Policy",
		key: "tool-collision",
		loader: () => runSuiteModule(() => import("./extension-lifecycle/tool_collision.test")),
	},
	{
		name: "Explicit Session Repair Command",
		key: "session-repair-command",
		loader: () => runSuiteModule(() => import("./session-repair/command_test")),
	},
	{
		name: "Multi-File Rollback State",
		key: "multifile-rollback-state",
		loader: () => runSuiteModule(() => import("./editing/multifile_rollback_state.test")),
	},
	{
		name: "File Mutation Concurrency",
		key: "mutation-concurrency",
		loader: () => runSuiteModule(() => import("./editing/mutation_concurrency.test")),
	},
	{
		name: "Smart Anchor Integrity",
		key: "smart-anchor-integrity",
		loader: () => runSuiteModule(() => import("./editing/smart_anchor_integrity.test")),
	},
	{
		name: "Shell Paging Evidence",
		key: "guard-paging-evidence",
		loader: () => runSuiteModule(() => import("./epistemic-guard/paging_evidence.test")),
	},
	{
		name: "Code Search Evidence Ranges",
		key: "guard-search-evidence",
		loader: () => runSuiteModule(() => import("./code-search-output/evidence_ranges.test")),
	},
	{
		name: "Kernel Configuration Validation",
		key: "config-validation",
		loader: () => runSuiteModule(() => import("./toml-config/config_validation.test")),
	},
	{
		name: "Project Configuration Trust",
		key: "config-trust",
		loader: () => runSuiteModule(() => import("./security-hardening/project_config_trust.test")),
	},
	{
		name: "Persisted Search Content Integrity",
		key: "cache-integrity",
		loader: () => runSuiteModule(() => import("./retrieval/cache_integrity.test")),
	},
	{
		name: "Search Cache Path Containment",
		key: "cache-containment",
		loader: () => runSuiteModule(() => import("./retrieval/cache_containment.test")),
	},
	{
		name: "System Prompt Boundary",
		key: "prompt-boundary",
		loader: () => runSuiteModule(() => import("./security-hardening/system_prompt_boundary.test")),
	},
	{
		name: "Runtime Packaging Dependencies",
		key: "packaging-runtime",
		loader: () => runSuiteModule(() => import("./packaging/runtime_dependency_test")),
	},
	{
		name: "Verified Release Artifact",
		key: "ci-artifact",
		loader: () => runSuiteModule(() => import("./ci/release_artifact_test")),
	},

	{
		name: "Immutable GitHub Action Pins",
		key: "ci-pinning",
		loader: () => runSuiteModule(() => import("./ci/workflow_pinning_test")),
	},
	{
		name: "Release Version Guard",
		key: "release-guard",
		loader: () => runSuiteModule(() => import("./release/version_guard_test")),
	},
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
		name: "BM25 Reliability",
		key: "bm25-reliability",
		loader: () => runSuiteModule(() => import("./retrieval/bm25_reliability.test")),
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
		name: "Mutation Continuity & Lock Safety",
		key: "mutation-continuity",
		loader: () => runSuiteModule(() => import("./mutation-continuity")),
	},
	{
		name: "Capped Read Tool",
		key: "read-tool",
		loader: () => runSuiteModule(() => import("./read-tool/read_cap_test")),
	},
	{
		name: "Batch Read Tool",
		key: "batch-read-tool",
		loader: () => runSuiteModule(() => import("./read-tool/batch_read_test")),
	},
	{
		name: "Read Tool Hint Accuracy",
		key: "read-tool-hint",
		loader: () => runSuiteModule(() => import("./read-tool/tool_hint_test")),
	},
	{
		name: "Dual Smart Anchor Engine Suite",
		key: "smart-anchor",
		loader: () => runSuiteModule(() => import("./editing/smart_anchor_test")),
	},
	{
		name: "Next-Gen Editing & Auto-Healing Suite",
		key: "nextgen-edit",
		loader: () => runSuiteModule(() => import("./editing/nextgen_edit_test")),
	},
	{
		name: "Multi-File Atomic Edit Suite",
		key: "multifile-edit",
		loader: () => runSuiteModule(() => import("./editing/multifile_edit_test")),
	},
	{
		name: "Security Hardening & Penetration Suite",
		key: "security-hardening",
		loader: () => runSuiteModule(() => import("./security-hardening")),
	},
	{
		name: "Windows Deep Cross-Platform Verification Suite",
		key: "windows-deep-verification",
		loader: () => runSuiteModule(() => import("./windows-deep-verification")),
	},
	{
		name: "Incremental Vector Indexing Suite",
		key: "incremental-update",
		loader: () => runSuiteModule(() => import("./retrieval/incremental_update.test")),
	},
	{
		name: "Gitignore & Workspace Traversal Suite",
		key: "gitignore-traversal",
		loader: () => runSuiteModule(() => import("./retrieval/gitignore_traversal.test")),
	},
];

async function main(): Promise<void> {
	console.log("=== Running Pi Agent Kernel Verification Suite ===\n");

	const requestedKey = process.argv[2];
	const selectedSuites = requestedKey ? suites.filter((suite) => suite.key === requestedKey) : suites;
	if (requestedKey && selectedSuites.length === 0) {
		throw new Error(`Unknown suite: ${requestedKey}`);
	}

	const previousPiDir = process.env.PI_DIR;
	const testPiDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-kernel-test-pi-"));
	process.env.PI_DIR = testPiDir;

	const startTime = Date.now();
	let passed = 0;
	let failed = 0;

	try {
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
		process.exitCode = failed > 0 ? 1 : 0;
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(testPiDir, { recursive: true, force: true });
	}
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    // Final guard: if the runner itself throws, exit non-zero.
    console.error("Test execution failed:", err);
    process.exit(1);
  });
