# Pi Agent Operating Kernel & Tooling Extensions (`pi-agent-kernel`)

A high-leverage agentic coding extension suite for `@earendil-works/pi-coding-agent`.

## Design Priorities

`pi-agent-kernel` is designed for bare-minimum token usage while maximizing
performance and reliability across agent work. It favors focused retrieval,
bounded output, deterministic checks, and grounded edits over unnecessary
context, background processing, or speculative automation.

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
