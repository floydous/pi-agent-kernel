# Changelog

## [0.3.2] - 2026-09-16

### Added
- **Statusline Retrieval Indicator & Extension Row Integration**: Relocated the retrieval profile tag from Line 1 to Line 2 (extension statusline via `ctx.ui.setStatus("retrieval", ...)`) alongside external extensions (such as Ponytail), preserving individual extension ANSI colors.
- **Profile Semantic Glyphs**: Added distinct visual tier glyphs: `🌿 retrieval:bm25` (AST lexical), `◈ retrieval:hybrid-256d` (Matryoshka hybrid), and `🧠 retrieval:dense-768d` (Full semantic).
- **Live Embedding Throughput & Stream Arrow Status**: Added real-time chunk processing throughput (`chunk/s`) with a static Stream Arrow indicator during workspace indexing (`🧠 retrieval:dense-768d ⇢ 45% (22/48 • 14.2 chunk/s)`).
- **Automatic Kernel Guidance Injection**: Bundled `AGENT_KERNEL_SYS_PROMPT.md` is injected through Pi's `before_agent_start` lifecycle hook, enabled by default and configurable with `[instructions] enabled = false`.
- **Benchmark Comparison Chart**: Added the latest aggregate harness comparison graphic at `static/benchmark-comparison.png` for display in the project README.
- **Six-Harness Cross-Agent Benchmark**: Integrated comprehensive multi-harness comparison runner supporting Pi Kernel, Pi Vanilla, Claude Code, Codex CLI, OMP, and OpenCode across 8 real-world tasks.
- **Passive Shield Architecture**: Gated exploratory tools (`ast_search`, `get_repo_map`, `lsp`) behind `enable_tools: false` / `PI_ENABLE_ALL_RETRIEVAL_TOOLS=1`, keeping the active tool interface lean (`read`, `edit`, `write`, `bash`, and compact `code_search`) to eliminate per-turn schema overhead and tool distraction loops.
- **Deterministic Delimiter Auto-Healing**: Added patch-scoped lexical delimiter balancing and Tree-sitter AST repair (`MISSING` node detection) to automatically recover truncated closing braces/brackets (`})`, `};`, `]}`) pre-write.
- **Line-Hinted Range Disambiguation & Multi-Block Line Deltas**: Added optional `line_hint`, `start_line`, and `end_line` parameters (supporting both camelCase and snake_case) to `edit` with sequential delta tracking to disambiguate identical search blocks without line-hash bloat.
- **Capped Plain-Text Reads**: Enforced 50KB / 2,000-line caps on broad reads with continuation hints (`offset`) and oversized line detection, recording precise exposure ranges in `EpistemicGuard`.
- **Model Property Aliasing & Epistemic Confirmation**: Supported model convention drift across parameter names (`search`/`replace`, `old`/`new`, `old_text`/`new_text`) and emitted concise positive confirmation strings (`Successfully applied edit to <file>.`) to prevent paranoid agent verification loops.

### Changed
- Included `AGENT_KERNEL_SYS_PROMPT.md` in the published package so automatic guidance works after installation.
- Added lifecycle coverage for guidance injection, duplicate prevention, and the disabled configuration path.
- **Tool Description Optimization**: Completely redesigned tool descriptions for `read` and `edit` to explicitly declare clean plain-text defaults and precision parameter expectations, dropping 10k+ prompt inflation tokens on real benchmarks.
- **Diagnostic Benchmark**: Cut token consumption by 50.6% (762k vs 1.54M total turn tokens) and reduced tool calls by 24.8% (112 vs 149) compared to unguided Pi Vanilla on the 8-task Luna High diagnostic suite.
- **Historical Benchmark**: In the initial v0.3.1-to-v0.4.0 Passive Shield evaluation, token consumption dropped from 1,214,112 tokens down to 465,139 tokens (-61.7%) across 8 real-world repositories.
- **Persistent Vector Profiles**: Preserved dimension-specific binary caches (`vectors-256d.bin`, `vectors-768d.bin`) on disk across profile switches, preventing cache loss when toggling to BM25.
- **On-Demand Embedder Loading**: Removed premature model preloading on startup; weights load on-demand only when unindexed chunks are detected.

### Fixed
- **Startup Background Indexing Visibility**: Fixed a bug where workspace indexing on `session_start` ran silently in the background without updating the UI statusline on cold or unindexed workspaces.
- **Companion Symbol Token Inflation**: Deduplicated companion symbols and clamped surrounding context lines during targeted symbol reads to eliminate token bloat.

### Removed
- Removed the obsolete `AGENT_KERNEL_PROPMPTS.md` prompt document.
