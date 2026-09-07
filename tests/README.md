# Tests

The agent-kernel test suite is organized by behavior. Each suite owns an
`index.ts` entry point and may contain focused test modules and static fixtures.

## Running tests

```sh
# Run the full suite
npm test

# Run a single suite
npx tsx tests/run-all.ts epistemic-guard
```

## Shared files

- `_setup.ts` — temporary workspaces, assertions, fixture loading, and suite runner.
- `polyglot_fixtures.ts` — loads committed source fixtures from `fixtures/`.
- `run-all.ts` — imports all normal suites in a deterministic order.

## Suites

| Suite | Coverage |
| --- | --- |
| `ast-extraction` | Polyglot AST extraction |
| `repo-map` | Repository map and PageRank |
| `symbol-reader` | Targeted symbol extraction |
| `single-block-patch` | Surgical single-block edits |
| `multi-block-patch` | Disjoint multi-block edits |
| `syntax-verification` | Syntax validation |
| `session-repair` | Session-file repair |
| `hybrid-search` | Hybrid search, chunking, cache, and abstention |
| `output-clamping` | Output clamping and discovery-command detection |
| `ui-width-safety` | TUI output-width regression |
| `epistemic-guard` | Read-before-write safety and session isolation |
| `unified-footer` | Footer formatting |
| `lsp-uri-and-detection` | LSP URI and language detection |
| `lsp-formatters` | Diagnostics, definitions, references, hover, and symbols |
| `lsp-manager` | LSP manager lifecycle and modals |
| `ast-fallback` | AST fallback extensions |
| `aliased-re-exports` | Aliased re-exports and dotted lookups |
| `typescript-ast` | TypeScript AST and parameter-scope hover |
| `rust-ast` | Rust AST and bleed defense |
| `toml-config` | TOML configuration |
| `extension-lifecycle` | Extension API lifecycle |
| `post-edit-verification` | Post-edit verification and diagnostic gates |
| `cache-retrieval` | Embedder cache and search-index retention |
| `end-to-end` | Cross-feature integration checks |
| `content-dedup` | Content-addressed deduplication |
| `recall-tool` | Recall validation and lookup |
| `dedup-hook` | End-to-end deduplication hook chain |
| `mutation-continuity` | Epistemic guard mutation continuity |
| `lsp-clean-and-filters` | Clean diagnostics and reference filters |
| `lsp-reference-snippets` | Reference snippet windowing |
| `ast-search-formatter` | Hierarchical AST search formatting |
| `tree-sitter` | Tree-sitter WASM engine |
| `audit-verification` | Cache and executable lookup verification |
| `cold-process-ast` | Fresh-process AST fallback contracts across 11 languages |

## Diagnostics and benchmarks

`diagnostics/cold-process-reproduction.ts` verifies first-process Tree-sitter
fallback behavior in isolated child processes. It fails if a required fixture
symbol, kind, or scope contract is wrong. It runs as part of `npm test`.

`benchmarks/retrieval.ts` is a manual performance/token benchmark and is not
part of `npm test`.

Tests use isolated temporary workspaces where needed. A single suite can be
selected with `npx tsx tests/run-all.ts <suite-key>`.
