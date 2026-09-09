# Changelog

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
