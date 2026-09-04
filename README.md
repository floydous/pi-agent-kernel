# Pi agent kernel

A Pi extension for code retrieval, surgical editing, safety checks, and language-server support.

## Design priorities

The extension keeps agent interactions small while improving reliability. It uses focused retrieval, bounded output, deterministic checks, and grounded edits. It avoids loading unnecessary context, doing background work without a reason, or making speculative changes.

## Token and performance measurements

The table compares this extension with an unconstrained harness that dumps whole files, walks the entire repository, rewrites files for every edit, and streams unbounded terminal output.

| Capability / Interaction | Unconstrained Harness | `pi-agent-kernel` | Token / Overhead Delta | Latency |
|---|---|---|---|---|
| **Context Ingestion** (Workspace map) | Raw recursive tree / full dump (~92.8k tokens) | PageRank AST Repo Map (~1.0k tokens) | **-98.9%** context tokens | ~40 ms |
| **Code Inspection** (Targeted function read) | Whole file read (~1.4k tokens) | AST Symbol Extraction (`read(symbol=...)`) (~428 tokens) | **-68.5%** prompt tokens | <1 ms |
| **Code Mutation** (Surgical function patch) | Full file rewrite (~1.4k tokens in tool payload) | Surgical search/replace (`edit`) (~58 tokens) | **-95.7%** output tokens | <5 ms |
| **Command Execution** (Large test/build output) | Unbounded stream (~27.5k tokens) | Bounded Clamp + Disk Spillover (~1.1k tokens) | **-95.9%** flood tokens prevented | Instant |
| **Codebase Search** (Lexical / BM25 Query) | Linear `grep`/`find` disk scan | Inverted In-Memory BM25 Index | **0 MB** background RAM (Lean) | ~0.03 ms / query |
| **Pre-Commit Safety** (Broken syntax gate) | Allowed to commit broken code | Local Fast AST Delimiter Gate | **Deterministic** failure block | Instant |

*These measurements come from `tests/benchmark_metrics.ts`, using this codebase with 45 source files and about 92.8k raw tokens.*

## Architecture and directory layout

Runtime code lives under `src/`. Tests, documentation, and example configuration remain at the repository root.

```
pi-agent-kernel/
├── src/
│   ├── index.ts            # Main extension entry point
│   ├── config/             # Hierarchical TOML configuration loader
│   ├── context/            # Context engineering and session repair
│   ├── editing/            # Surgical patching and verification
│   ├── lsp/                # Language Server Protocol integration
│   ├── retrieval/          # AST, BM25, and semantic code search
│   ├── safety/             # Epistemic guards and bounded execution
│   ├── tools/              # Pi tool registrations
│   └── ui/                 # Terminal UI components
├── tests/                  # Focused verification sections
├── docs/                   # Project documentation and guides
├── config.toml             # Live configuration
└── package.json            # Extension manifest
```

## Tool suite

| Tool | Purpose | Output Strategy |
|---|---|---|
| `read` | Content and surgical AST symbol inspection | Bounded, zero bloat, line-targeted |
| `edit` | Exact and fuzzy surgical patching with a syntax gate | Empty on clean (`OK!`), diagnostic on `WARN/FAIL` |
| `write` | Complete new-file authoring | Direct write |
| `get_repo_map` | PageRank-ranked repository AST definitions | Pure code symbols without import noise (~1k tokens) |
| `ast_search` | AST structure search across definitions | Concise `file:line [kind] signature` |
| `code_search` | Hybrid BM25 and semantic AST chunk search | Compact `file:start-end (breadcrumb)` snippets |
| `lsp` | Realtime Language Server Protocol queries | Compact `def`, `ref`, and structural symbols |
| `recall` | Restore an exact deduplicated tool result by reference | Bare original output content |
| `search_tools` | Deferred tool discovery | On-demand tool capability matching |

## Safety and invariants

- **Epistemic Guard**: Requires inspection before editing an existing file. It rejects ungrounded edits with short, copyable instructions and preserves authorization across sequential mutations.
- **Output Clamping**: Limits stdout and stderr so they do not fill the context window, while saving complete output to disk.
- **Tool Result Deduplication**: Replaces byte-identical repeated output with a small `[=rN,sizeB,tool,paramsKey]` notice that can be recovered with `recall`.
- **Bounded Syntax Verification**: Runs a fast local check on mutations before committing changes to disk.

## Installation

Install the extension as a Pi package, either globally or in a project:

```bash
pi install npm:@floydous/pi-agent-kernel
```

For a project-local installation:

```bash
pi install -l npm:@floydous/pi-agent-kernel
```

The entry point is declared in `package.json` under `pi.extensions` (`./src/index.ts`). Pi loads it when a session starts.

## Slash commands

| Command | Args | Purpose |
|---|---|---|
| `/repomap` | `[budget]` | Render the AST and PageRank-ranked repository map. The default budget is 1024 tokens. |
| `/engine` | `auto\|lean\|hybrid\|full\|off\|status\|reindex` | Change the retrieval profile or inspect engine state. `lean` is the default and uses AST-aware BM25; `hybrid` adds local embeddings. |
| `/lsp` | `[install <lang>]` | Inspect active language servers or install one, for example `/lsp install python`. |

## Configuration

The loader resolves configuration per workspace. It looks for `agent-kernel/config.toml` or `config.toml` at the workspace root and then walks upward. The built-in defaults are in [`src/config/kernel_config.ts`](src/config/kernel_config.ts), and the example configuration is [`config.toml`](config.toml). See [`docs/configuration.md`](docs/configuration.md) for the full schema and override rules.

The top-level sections are `[retrieval]`, `[safety]`, `[lsp]`, and `[ui]`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): module map and request flow
- [`docs/retrieval.md`](docs/retrieval.md): search profile semantics
- [`docs/editing-and-verification.md`](docs/editing-and-verification.md): patch and verification pipeline
- [`docs/lsp.md`](docs/lsp.md): LSP integration and registry
- [`docs/configuration.md`](docs/configuration.md): TOML schema and precedence
- [`docs/testing.md`](docs/testing.md): section-based test layout

## License

ISC. See [`LICENSE`](LICENSE).
