# Changelog

## [Unreleased]

### Added

- Hierarchical grouped formatting for `ast_search` tool output: groups results by normalized file path and symbol kind, reducing repeated token overhead by ~34%.
- Support for inline singleton layout and multi-item bulleted lists in AST search results.
- Bounded body preview indentation and explicit `[... body preview truncated at line N]` markers.
- Polyglot regex fallback extractors in `repomap.ts` for Java, C#, C++, Ruby, PHP, and Bash when Tree-sitter is in a cold/uninitialized state.
- Suite Section 38 (`ast_search_formatter_test.ts`) integrated into `tests/run-all.ts` verifying hierarchical grouping, polyglot signature cleaning, alias metadata preservation, and epistemic guard recording coverage.

### Changed

- `cleanSignature` strips redundant declaration words (`export`, `public`, `private`, `protected`, `function`, `def`, `fn`, `func`, `class`, `interface`, `type`, `struct`, `trait`, accessors `get`/`set`, and `abstract`) while preserving semantic modifiers (`async`, `static`, `readonly`, `unsafe`, `const`, `mut`) and complete parameter/return type structures.
- On-demand grammar preloading in `ast_search` when targeted file queries specify a recognized language extension.

### Fixed

- Eliminated heuristic text-based alias guessing that previously misclassified typed method return types (e.g. `public void run()`) and accessor keywords as aliases. Alias annotations (`[alias of original]`) now strictly require explicit `aliasedFrom` AST metadata.
- Ensured truncation markers are consistently attached to body previews even when the code preview is empty or a single-line stub.
- Stripped redundant kind keywords following semantic modifiers (e.g. `pub unsafe fn` -> `unsafe`, `static function` -> `static`).

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
