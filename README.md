# Pi Agent Operating Kernel & Tooling Extensions (`agent-kernel`)

A high-leverage agentic coding extension suite for `@earendil-works/pi-coding-agent`.

## Architecture & Directory Layout

```
agent-kernel/
├── index.ts                # Main extension entry point & behavioral kernel prompt
├── package.json            # Extension metadata & dependencies
├── README.md               # Architecture documentation
├── test.ts                 # Full verification test runner (15 phases)
│
├── retrieval/              # Hybrid AST indexing & semantic code search
│   ├── search_index.ts     # Inverted BM25 + Vector index coordinator (RRF)
│   ├── search_bm25.ts      # Fast AST-aware BM25 engine with code tokenizer
│   ├── search_chunker.ts   # Tree-Sitter syntax chunker with breadcrumbs
│   ├── search_embedder.ts  # Local ONNX transformer embedder (Nomic 1.5)
│   ├── search_config.ts    # Hardware detection & profile configuration
│   ├── search_modal.ts     # Interactive full-viewport TUI settings panel
│   ├── repomap.ts          # PageRank-ranked repository AST symbol graph
│   ├── ast_search.ts       # Structural symbol declaration search
│   └── symbol_reader.ts    # Surgical symbol boundary extractor
│
├── editing/                # Surgical diff editing & atomic git
│   ├── patch.ts            # 3-tier fuzzy search/replace matching engine
│   └── git-verify.ts       # Syntax validation gate & atomic auto-commit/undo
│
├── safety/                 # Epistemic safety guards & verification oracles
│   ├── epistemic_guard.ts  # Read-before-write grounding invariant guard
│   ├── test_oracle.ts      # Deterministic binary test/type-check evaluator
│   ├── output_clamper.ts   # Horizontal width clamper & match flood capper
│   ├── atomic_write.ts     # Crash-safe tmp+rename file writes (JSON stores)
│   └── kernel_debug.ts     # PI_KERNEL_DEBUG-gated sink for best-effort catches
│
├── context/                # Context engineering & session repair
│   ├── compaction_enhanced.ts  # Chronological monotonic summary hook
│   └── session_repair.ts       # Self-healing JSONL session metadata sanitizer
│
├── ui/                     # Terminal user interface components
│   └── footer.ts           # Aesthetic 24-bit TrueColor pastel statusline
├── config/                 # Hierarchical TOML configuration loader
│   ├── kernel_config.ts    # Defaults -> global -> project -> env merge
│   └── toml.ts             # Zero-dependency TOML parser/serializer
```

## Verified Features

1. **Direct Behavioral Kernel (`index.ts`)**: Direct unblocked execution with strict epistemic grounding and 6-tier instruction precedence.
2. **Hybrid Retrieval (`retrieval/`)**: `retrieval:bm25` (Lean), `retrieval:hybrid-256d` (Hybrid Matryoshka), and `retrieval:dense-768d` (Full).
3. **Surgical Patching (`editing/`)**: Multi-strategy fuzzy search/replace with immediate syntax validation.
4. **Epistemic Read-Before-Write (`safety/`)**: Blocks hallucinated file mutations on uninspected files.
5. **Deterministic Test Oracle (`safety/`)**: Evaluates real binary exit codes (`/oracle [cmd]`).
   > ⚠️ `/oracle <command>` executes the given command through the system shell with your user privileges — by design, as an explicitly user-invoked verification escape hatch. Only pass commands you trust.
6. **Chronological Compaction (`context/`)**: Reconciles task progress against deterministic Git state.
7. **Semantic Pastel Footer (`ui/`)**: 24-bit TrueColor ANSI statusline with live token usage and context percentage gauge.
