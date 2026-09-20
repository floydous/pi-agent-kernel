# Changelog

## [0.3.3] - 2026-09-20

### Added
- **Multi-File Atomic Edits**: Extended the `edit` tool with `files: { path, search, replace, line_hint, edits }[]` payload (with resilient per-item `path` normalization in `edits`). Implemented a 2-stage atomic commit with preflight validation, duplicate path detection, in-memory snapshot backups, and automatic rollback across all targets if any file fails patch application or syntax verification.
- **Batch Multi-File `read`**: Extended the `read` tool to accept `paths: string[]` (and resilient alias `path: string[]`), allowing the model to inspect multiple files in one turn while authorizing all targets in `EpistemicGuard`.
- **Automatic Turn 1 Reproduction Diff Grounding**: In `before_agent_start`, automatically detects unstaged/staged git diffs and injects a sanitized, clamped (max 25 lines, 2KB hard ceiling) reproduction status into initial context with session caching, eliminating redundant Turn 1 exploratory `git status` / `git diff` commands.

### Changed
- **Read Tool Budgeting & Anchor Guardrails**: Bounded batch reading to 150 lines per file and a 24KB aggregate ceiling with explicit continuation markers (`[truncated: <file>, returned lines 1-150 of <N>. Continue with read(path, offset=151)]`). Added a 100-line cap on explicit `anchors: true` requests (`MAX_ANCHOR_LINES = 100`) to prevent models from generating expensive `#HASH│` line hashes on large files.
- **Targeted Reading Workflow Guidance**: Updated `AGENT_KERNEL_SYS_PROMPT.md` to emphasize targeted sequential reads (`read(path, offset, limit)`) centered on search coordinates as the primary inspection workflow, reserving batch `paths` for short files or known regions.
- **Search Specificity Guidance**: Directed agents toward exact identifiers, error symbols, and test phrases, preventing noisy broad single-word searches from polluting conversation context.

### Validated
- Verified 38 test suites passing (`npm test`) with 0 regressions.
- Multi-harness benchmarks on `cx/gpt-5.6-luna:high` demonstrate 100% solve rate, ~60% wall-clock speedup across tasks (e.g. UFO 36s vs 119s, p-limit 60s vs 176s, Fastify 47s vs 177s, Ky 89s vs 253s), and beat baseline token consumption on `task-4-ufo` (-17.5%), `task-7-uuid` (-20.2%), and `task-8-plimit` (-9.8%).

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
