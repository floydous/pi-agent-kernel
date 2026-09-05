# Changelog

## [0.2.0] - 2026-09-05

This release replaces the old line-based symbol extraction path with a Tree-sitter WASM parser where a bundled grammar is available, while keeping the scanner fallback for unsupported or unavailable languages.

### Added

- Tree-sitter WASM parsing for TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, C#, Bash, Ruby, and PHP.
- AST-based symbol lookup and reference extraction that handles class methods and ignores identifiers inside comments and strings.
- Support for exact AST end lines when reading symbols and building search chunks.
- Parsing for additional constructs including abstract and ambient TypeScript declarations, Go interfaces, Rust traits, and C++ member methods.
- Regression coverage for the parser, cache, repository map, LSP lookup, and polyglot extraction paths.

### Changed

- Grammars load on demand for languages found in the workspace instead of loading every grammar at startup.
- Search caches now record the extractor generation and reject caches produced by an older extractor.
- Repository-map startup waits for Tree-sitter initialization, including the `/repomap` command path.
- LSP executable lookup checks both the extension-local directory and the legacy user directory.
- Hover output removes transient `(loading...)` markers returned by language servers.
- `typebox` is now packaged as a runtime dependency.

### Fixed

- Native Tree-sitter parse trees are released after extraction.
- Local variables no longer appear as top-level repository-map symbols.
- Braces in strings and comments no longer truncate symbol content.
- Syntax errors are reported on extracted file tags.
- LSP reference filtering preserves the intended fallback behavior.

[0.2.0]: https://github.com/floydous/pi-agent-kernel/releases/tag/v0.2.0
