# Pi Agent Operating Kernel & Tooling Extensions (`pi-agent-kernel`)

A high-leverage agentic coding extension suite for `@earendil-works/pi-coding-agent`.

## Design Priorities

`pi-agent-kernel` is designed for bare-minimum token usage while maximizing
performance and reliability across agent work. It favors focused retrieval,
bounded output, deterministic checks, and grounded edits over unnecessary
context, background processing, or speculative automation.

## Empirical Performance & Token Efficiency

Compared to unconstrained agent harnesses (which dump full files, perform raw directory walks, rewrite entire source files on every edit, and stream unbounded terminal stdout directly into context), `pi-agent-kernel` optimizes token consumption and execution latency across every interaction turn:

| Capability / Interaction | Unconstrained Harness | `pi-agent-kernel` | Token / Overhead Delta | Latency |
|---|---|---|---|---|
| **Context Ingestion** (Workspace map) | Raw recursive tree / full dump (~92.8k tokens) | PageRank AST Repo Map (~1.0k tokens) | **-98.9%** context tokens | ~40 ms |
| **Code Inspection** (Targeted function read) | Whole file read (~1.4k tokens) | AST Symbol Extraction (`read(symbol=...)`) (~428 tokens) | **-68.5%** prompt tokens | <1 ms |
| **Code Mutation** (Surgical function patch) | Full file rewrite (~1.4k tokens in tool payload) | Surgical search/replace (`edit`) (~58 tokens) | **-95.7%** output tokens | <5 ms |
| **Command Execution** (Large test/build output) | Unbounded stream (~27.5k tokens) | Bounded Clamp + Disk Spillover (~1.1k tokens) | **-95.9%** flood tokens prevented | Instant |
| **Codebase Search** (Lexical / BM25 Query) | Linear `grep`/`find` disk scan | Inverted In-Memory BM25 Index | **0 MB** background RAM (Lean) | ~0.03 ms / query |
| **Pre-Commit Safety** (Broken syntax gate) | Allowed to commit broken code | Local Fast AST Delimiter Gate | **Deterministic** failure block | Instant |

*Empirical metrics measured against this codebase (45 source files, ~92.8k raw tokens) using `tests/benchmark_metrics.ts`.*

## Architecture & Directory Layout

Authored runtime code lives under `src/`; tests, documentation, and example
configuration stay at the repository boundary.

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

## Tool Suite

| Tool | Purpose | Output Strategy |
|---|---|---|
| `read` | Content & surgical AST symbol inspection | Bounded, zero bloat, line-targeted |
| `edit` | Exact & fuzzy surgical patching with syntax gate | Empty on clean (`OK!`), diagnostic on `WARN/FAIL` |
| `write` | Complete new file authoring | Direct write |
| `get_repo_map` | PageRank-ranked repository AST definitions | Pure code symbols without import noise (~1k tokens) |
| `ast_search` | AST structure search across definitions | Concise `file:line [kind] signature` |
| `code_search` | Hybrid BM25 & semantic AST chunk search | Compact `file:start-end (breadcrumb)` snippets |
| `lsp` | Realtime Language Server Protocol queries | Compact `def`, `ref`, and structural symbols |
| `search_tools` | Deferred tool discovery | On-demand tool capability matching |

## Safety & Invariants

- **Epistemic Guard**: Enforces inspection-before-mutation (`read` required before `edit`). Rejects ungrounded edits with copy-pasteable minimal instructions.
- **Output Clamping**: Prevents context-window blowouts by clamping stdout/stderr and persisting full dumps to disk.
- **Bounded Syntax Verification**: Fast local verification on mutations before committing changes to disk.

## Installation

`pi-agent-kernel` is consumed by Pi as a packaged extension. Install globally or in your project:

```bash
pi install npm:pi-agent-kernel
```

Or install in your project locally:

```bash
pi install -l npm:pi-agent-kernel
```

The entry point is declared in `package.json` under `pi.extensions` (`./src/index.ts`); Pi loads it on session start.

## Slash Commands

| Command | Args | Purpose |
|---|---|---|
| `/repomap` | `[budget]` | Render the AST + PageRank-ranked repo map. Default budget 1024 tokens. |
| `/engine` | `auto\|lean\|hybrid\|full\|off\|status\|reindex` | Switch retrieval profile or inspect engine state. `hybrid` is default out-of-the-box (fast BM25 + ONNX embeddings), `lean` is BM25 only. |
| `/lsp` | `[install <lang>]` | Inspect active language servers / daemons, or install a server (`/lsp install python`). |

## Configuration

Configuration is resolved hierarchically per workspace, looking for `agent-kernel/config.toml` (or `config.toml`) in the workspace root and walking upward. The shipped defaults are defined in [`src/config/kernel_config.ts`](src/config/kernel_config.ts) and the example config lives at [`config.toml`](config.toml). Full schema and override semantics are in [`docs/configuration.md`](docs/configuration.md).

Top-level keys: `[retrieval]`, `[safety]`, `[lsp]`, `[ui]`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — module map and request flow
- [`docs/retrieval.md`](docs/retrieval.md) — search profile semantics
- [`docs/editing-and-verification.md`](docs/editing-and-verification.md) — patch + verify pipeline
- [`docs/lsp.md`](docs/lsp.md) — LSP integration & registry
- [`docs/configuration.md`](docs/configuration.md) — TOML schema and precedence
- [`docs/testing.md`](docs/testing.md) — section-based test layout

## License

ISC — see [`LICENSE`](LICENSE).
