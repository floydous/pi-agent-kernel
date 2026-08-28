# Pi Agent Operating Kernel & Tooling Extensions (`agent-kernel`)

A high-leverage agentic coding extension suite for `@earendil-works/pi-coding-agent`.

## Architecture & Directory Layout

Authored runtime code lives under `src/`; tests, documentation, and example
configuration stay at the repository boundary.

```
agent-kernel/
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
├── examples/
│   └── config.example.toml # Example user configuration
├── docs/                   # Project documentation and guides
├── test.ts                 # Compatibility shim for the full test suite
├── README.md
└── package.json
```

Each `src/` subsystem owns its implementation and public exports. `src/index.ts`
is the integration boundary that registers the extension with Pi. The package
entry is `src/index.ts`; the root `test.ts` exists only for test compatibility.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Editing and verification](docs/editing-and-verification.md)
- [Retrieval](docs/retrieval.md)
- [Testing](docs/testing.md)

## Verified Features

1. **Direct Behavioral Kernel (`src/index.ts`)**: Direct unblocked execution with strict epistemic grounding and 6-tier instruction precedence.
2. **Hybrid Retrieval (`src/retrieval/`)**: `retrieval:bm25` (Lean), `retrieval:hybrid-256d` (Hybrid Matryoshka), and `retrieval:dense-768d` (Full).
3. **Surgical Patching (`src/editing/`)**: Multi-strategy fuzzy search/replace with immediate syntax validation.
4. **Epistemic Read-Before-Write (`src/safety/`)**: Blocks hallucinated file mutations on uninspected files.
5. **Deterministic Test Oracle (`src/safety/`)**: Evaluates real binary exit codes (`/oracle [cmd]`).
   > ⚠️ `/oracle <command>` executes the given command through the system shell with your user privileges — by design, as an explicitly user-invoked verification escape hatch. Only pass commands you trust.
6. **Chronological Compaction (`src/context/`)**: Reconciles task progress against deterministic Git state.
7. **Semantic Pastel Footer (`src/ui/`)**: 24-bit TrueColor ANSI statusline with live token usage and context percentage gauge.
