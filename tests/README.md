# Tests

The agent-kernel test suite is split into one file per logical test under this directory.

The suite supports the project's core priorities: bare-minimum token usage,
maximum performance, and reliable agent behavior. Tests emphasize bounded
outputs, deterministic verification, read-before-write safety, and isolated
execution.

## Running tests

```sh
# Run the full suite (recommended)
npx tsx test.ts                # via the legacy shim
npx tsx tests/run-all.ts       # the actual runner

# Run a single test in isolation
npx tsx tests/section-13-epistemic-guard.ts
```

## File layout

- `_setup.ts` — shared helpers (`createTestWorkspace`, `assertPass`, `logPass`, `runSection`).
- `run-all.ts` — orchestrator. Imports each section in order, catches failures, prints a summary.
- `section-XX-name.ts` — one test per file. Each test creates its own temp workspace, so tests are fully independent.

## Test files

| File | What it tests |
| --- | --- |
| `section-01-ast-extraction.ts` | `extractFileTags` for Python class/method extraction |
| `section-03-repo-map.ts` | `computeRepoMap` and PageRank ranking on a real workspace |
| `section-04-symbol-reader.ts` | `extractSymbolContent` for absolute and relative paths on large files |
| `section-05-single-block-patch.ts` | `applySurgicalPatch` with path-agnostic search/replace |
| `section-06-multi-block-patch.ts` | `applyMultiBlockPatch` with disjoint edit blocks |
| `section-07-syntax-verification.ts` | `checkSyntax` detects valid and broken Python |
| `section-08-git-autocommit-undo.ts` | `autoCommitFile` and `undoLastCommit` work end-to-end |
| `section-08.1-undo-preserves-working-tree.ts` | `undoLastCommit` uses `--mixed` (preserves working tree) and reports `dirtyWorkingTree` |
| `section-09-session-repair.ts` | `sanitizeSessionFiles` heals missing `usage.cost.total` |
| `section-10-hybrid-search.ts` | `HybridSearchIndex` chunking, search, and indexing fallback |
| `section-11-output-clamping.ts` | `clampCommandOutput` and `isDiscoveryCommand` |
| `section-12-compaction-engine.ts` | `extractGitGroundTruth`, `extractTrajectoryDigest`, `buildChronologicalCompactionPrompt` |
| `section-12.1-compaction-prompt-caching.ts` | `buildCompactionSystemPrompt` keeps static instructions in the system prompt for caching |
| `section-13-epistemic-guard.ts` | `EpistemicGuard` blocking, per-session scope, case-sensitivity |
| `section-14-test-oracle.ts` | `runOracle` correctly reports pass/fail based on exit code |
| `section-15-unified-footer.ts` | `renderFooter` produces a properly formatted line with TrueColor codes |
| `section-16-lsp-uri-and-detection.ts` | LSP URI/Path roundtrip, language detection, workspace root |
| `section-17-lsp-formatters.ts` | LSP diagnostics, definitions, references, hover, document symbols |
| `section-18-lsp-manager-modals.ts` | `LspManager` lifecycle, `LspControlModal`, `LspDownloadModal` |
| `section-19-ast-fallback-extensions.ts` | `extractDocumentSymbols`, `findSymbolReferences`, `extractLocalSymbolHover` |
| `section-20-aliased-re-exports.ts` | Aliased re-exports, multi-line signatures, dotted lookups |
| `section-21-typescript-ast.ts` | TypeScript full AST, parameter scope hover |
| `section-22-rust-ast.ts` | Rust full AST, struct bleed defense, comment filtering |
| `section-23-toml-config.ts` | TOML parser, serializer, kernel config loader |
| `section-24-extension-lifecycle.ts` | Extension API lifecycle, custom prompt preservation, tool registration |

## Notes

- Each test file creates its own temp git workspace. Tests are fully independent — you can run them in any order, in parallel, or skip individual ones.
- `assertPass` throws on failure (rather than calling `process.exit`) so the runner can catch and continue with the next section.
- The root `test.ts` remains a thin compatibility shim that imports `tests/run-all.ts`, preserving the `npx tsx test.ts` UX after runtime code moved under `src/`.
