# Changelog

## [0.4.0] - 2026-09-16

### Added
- **Automatic Kernel Guidance Injection**: Bundled `AGENT_KERNEL_SYS_PROMPT.md` is injected through Pi's `before_agent_start` lifecycle hook, enabled by default and configurable with `[instructions] enabled = false`.
- **Benchmark Comparison Chart**: Added the latest aggregate harness comparison graphic at `static/benchmark-comparison.png` for display in the project README.
- **Passive Shield Architecture**: Gated exploratory tools (`code_search`, `ast_search`, `get_repo_map`, `lsp`) behind `enable_tools: false` / `PI_ENABLE_RETRIEVAL_TOOLS=1`, reducing active tool interface to the minimalist core 4 (`read`, `edit`, `write`, `bash`) to eliminate per-turn schema overhead (~3,400 tokens/turn) and tool distraction loops.
- **Deterministic Delimiter Auto-Healing**: Added patch-scoped lexical delimiter balancing and Tree-sitter AST repair (`MISSING` node detection) to automatically recover truncated closing braces/brackets (`})`, `};`, `]}`) pre-write.
- **Line-Hinted Range Disambiguation**: Added optional `line_hint` parameter to `edit` tool allowing targeted disambiguation of identical search blocks without paying line-hash bloat.
- **Capped Plain-Text Reads**: Enforced 50KB / 2,000-line caps on broad reads with continuation hints (`offset`) and oversized line detection, recording precise exposure ranges in `EpistemicGuard`.
- **Three-Way Benchmark Suite**: Integrated comprehensive 8-task comparison harness supporting Pi Vanilla, Kernel v0.3.1, and Kernel Current.

### Changed
- Included `AGENT_KERNEL_SYS_PROMPT.md` in the published package so automatic guidance works after installation.
- Added lifecycle coverage for guidance injection, duplicate prevention, and the disabled configuration path.
- **Tool Description Optimization**: Completely redesigned tool descriptions for `read` and `edit` to explicitly declare clean plain-text defaults and precision parameter expectations, dropping 10k+ prompt inflation tokens on real benchmarks.
- **Performance**: Cut 8-task benchmark token consumption from **1,214,112 tokens down to 465,139 tokens (-61.7%)**, outperforming stock Pi Vanilla (579,088 tokens, -19.7% overall) across 8 real-world repositories.

### Removed
- Removed the obsolete `AGENT_KERNEL_PROPMPTS.md` prompt document.

## [0.3.1] - 2026-09-09

### Added

- **Adaptive Codebase Profiles**: Introduced `/profile` command with `auto`, `light`, and `heavy` profiles dynamically adjusting repository map token budgets, indexing thresholds, and test file separation based on workspace scale.
- **Bare-Symbol LSP Definition Lookup**: Support looking up symbol definitions directly by symbol name across the workspace without requiring explicit file paths or line/column coordinates.
- **Fuzzy Symbol Suggestions**: When a requested symbol is not found during targeted reading, suggest close matching symbols within the file to guide navigation.
- **LSP Provenance Metadata & Directory Guard**: Explicitly surface result provenance (active language server vs. Tree-sitter fallback) on LSP responses, and guard against passing directory paths to diagnostics.
- **Adaptive Code Search Formatting & Scopes**: Added token-efficient result layouts and scope filtering (`code` vs `all`) for code search.
- **Navigation Session Benchmarks**: Added automated benchmarks evaluating token efficiency and call counts across navigation and discovery tools.

### Changed

- **Compact Tool Schemas**: Minified tool descriptions and schemas across tools to reduce system prompt overhead and save context tokens.
- **Optimized Repository Map Ranking**: Enhanced PageRank scoring heuristics and budget management to prioritize core implementation symbols over tests and boilerplate.

[0.3.1]: https://github.com/floydous/pi-agent-kernel/compare/v0.3.0...v0.3.1
