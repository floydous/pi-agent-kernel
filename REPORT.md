# Agent-kernel audit

## Executive summary

The update moves the project in the right direction, but it is not yet accurate to describe the current implementation as both token-efficient and maximum-performance.

The strongest part is the architectural move from line-oriented declaration scanning to grammar-backed Tree-sitter WASM parsing. It fixes the concrete TypeScript class-method lookup failure that started this investigation. The parser is self-contained, offline, cross-platform, and does not require native Node addons.

The current integration has several release-blocking issues:

1. Parsed Tree objects are never released. Repeated searches leak native memory.
2. Parser startup races workspace indexing. A fallback index can become permanently fresh according to file hashes even after the Tree-sitter parser becomes ready, so methods remain missing until a file changes or the user manually reindexes.
3. Downstream symbol readers and chunkers still calculate ranges with raw brace counting. Braces in strings and comments produce truncated or overextended symbol bodies even though Tree-sitter itself parsed the source correctly.
4. The visitor emits local variables, nested functions, and object-literal methods as repository symbols. This increases index size and makes the compact repository map spend its budget on implementation details.
5. The parser eagerly loads all language grammars on startup, adding measurable startup time and memory even in lean mode.
6. The LSP binary-directory change moves a previously user-writable path into the extension directory, while installer comments and storage assumptions still refer to the old user directory.

The full test suite passing is useful evidence for basic integration, not evidence that the exact structural-search contract is reliable across languages, malformed syntax, startup timing, cache state, or long-running processes.

## Audit boundary and baseline

This report covers the working tree at `bcdb75e` and the uncommitted update around the Tree-sitter engine.

Observed repository state before this report was written:

- Local `master` was one commit ahead of `origin/master`.
- Modified tracked files included `package.json`, `package-lock.json`, `src/index.ts`, `src/lsp/lsp_registry.ts`, `src/retrieval/ast_search.ts`, `src/retrieval/repomap.ts`, and `tests/run-all.ts`.
- New files included `src/retrieval/tree_sitter_engine.ts`, `tests/section-36-tree-sitter-wasm.ts`, `grammars/`, `AGENT_KERNEL_PROPMPTS.md`, and the untracked `AGENTS.md`.
- No source files were changed as part of this audit. This report is the audit artifact.
- `feedback.txt` was not modified.

Verified checks:

```text
npm run typecheck                         passed
npx tsx tests/section-36-tree-sitter-wasm.ts  passed
npm test                                  30 passed, 0 failed
 git diff --check                          passed
```

The new Section 36 test reported 20 active parser extensions.

The package preview reported:

```text
archive size:    2,264,481 bytes
unpacked size:  20,347,745 bytes
entries:                  76
WASM assets:      19,545,800 bytes unpacked
```

The four test screenshots and other package files were included in the preview. The published npm `0.1.0` package predates this update; no publication was performed during this audit.

## What is strong

### The parser choice is sound

`src/retrieval/tree_sitter_engine.ts` uses `web-tree-sitter` and packaged WASM grammars rather than another regular-expression layer or a native Node parser addon.

That gives the project:

- grammar-backed parsing for TypeScript, TSX, JavaScript, Python, Rust, Go, C, C++, Java, C#, Bash, Ruby, and PHP;
- exact parser positions available through Tree-sitter nodes;
- syntax-error recovery rather than an immediate all-or-nothing parse failure;
- no network request needed to parse a file;
- no platform-specific native addon build requirement;
- one loaded language object reused by multiple file extensions;
- a compatibility fallback when the parser is not ready or cannot handle an extension.

The WASM approach is a good fit for a Pi package. The compressed package is relatively small compared with its unpacked grammar assets, and the grammars are available without relying on a system compiler installation.

### It fixes the observed method lookup failure

After initialization, this query now resolves the method that the old extractor missed:

```text
ast_search checkReadPrecondition [method]
```

Observed result:

```text
src/safety/epistemic_guard.ts:614 [method]
```

The same parser-produced definition flows through `extractFileTags()`, `searchAstSymbols()`, `chunkFile()`, and the repository-map path. A disposable workspace also confirmed that a parser-ready index contains a separate `checkReadPrecondition` method chunk.

### It filters declaration false positives better than the old scanner

For supported files after initialization, comments and string contents did not become declaration records. For example, a source file containing fake methods in comments and strings produced only the real class and method definitions.

This is a real improvement over adding more declaration regular expressions.

### Initialization is coalesced

`TreeSitterEngine.init()` keeps a shared initialization promise, so concurrent callers do not independently load all grammars. The parser and language maps also avoid loading the same language WASM more than once for multiple extensions.

### Existing output controls remain useful

The update did not remove the existing compact-output mechanisms:

- bounded AST search result rendering;
- bounded code-search limits;
- output clamping and spillover files;
- exact-result deduplication and recall;
- lean mode without embedding-model loading;
- the epistemic read-before-write guard.

Those controls still support the project philosophy. The new parser currently weakens some of their benefits through index noise and initialization overhead, but the surrounding design is still coherent.

## Findings requiring attention

### 1. High severity: Tree objects are never deleted

**Location:** `src/retrieval/tree_sitter_engine.ts`, `extractTags()`

The method calls `parser.parse(content)` and retains the returned Tree only through local variables. It never calls the Tree-sitter `tree.delete()` method.

This is not merely a style issue. A stress test using a 500-line TypeScript fixture showed the following native-memory behavior after 100 parses:

```text
with tree.delete():
  RSS       83.8 MB -> 85.1 MB
  external  36.8 MB -> 35.5 MB

without tree.delete():
  RSS       84.0 MB -> 161.3 MB
  external  36.8 MB -> 83.3 MB
```

The exact values depend on the runtime and fixture, but the direction is clear. Repository maps, AST searches, symbol reads, and index rebuilds all parse repeatedly. A long-lived Pi process or RPC host can accumulate native memory.

**Required fix:** gather all strings, numbers, and normalized records inside a `try` block and release the Tree in a `finally` block. Add a repeated-parse regression test that checks for bounded memory growth rather than relying only on a small functional fixture.

### 2. High severity: parser readiness races indexing

**Locations:**

- `src/index.ts`, eager background `TreeSitterEngine.init()` call;
- `src/retrieval/repomap.ts`, synchronous `extractFileTags()` dispatch;
- `src/index.ts`, `session_start` background index synchronization.

`TreeSitterEngine.isSupported()` is false until asynchronous initialization completes. During that interval, `extractFileTags()` uses the old heuristic scanner. The first workspace index can therefore be created before Tree-sitter is ready.

This was reproduced in a disposable workspace:

```text
index sync before parser readiness: 46 chunks
search after parser readiness:       only the Guard class contained the method
index sync after parser readiness:   47 chunks
search after a fresh sync:            checkReadPrecondition method + Guard class
```

The file content did not change between those runs.

The problem is made persistent by the search cache. `HybridSearchIndex.loadFromDisk()` validates the cache using `version: 1` and file hashes, but it does not record the parser/tagger generation. If fallback chunks were created with the same file hashes, the cache can be considered fresh after Tree-sitter becomes ready.

This means the extension can report a fresh index while still missing the method declarations the update was meant to add.

**Required fix:** choose one explicit lifecycle:

- await parser readiness before the first index;
- or make parser readiness invalidate all affected indexes;
- and bump or extend the search-cache schema with a tagger/parser generation so a parser implementation change forces re-chunking.

A test must cover both startup ordering and an old cache created before parser initialization.

### 3. High severity: parser positions are discarded before range consumers use them

Tree-sitter knows the complete node range, but `SymbolDef` still carries only `line`. The downstream consumers continue to find symbol ends with line-based brace counting:

- `src/retrieval/ast_search.ts`, `findSymbolEndLine()`;
- `src/retrieval/symbol_reader.ts`, brace-based extraction;
- `src/retrieval/search_chunker.ts`, brace-based chunk spans.

Those functions do not ignore strings or comments.

A valid TypeScript function containing a string with a closing brace was parsed correctly, but the downstream result ended at line 2 instead of the function's actual closing line. `extractSymbolContent()` returned only:

```text
1 | function f() {
2 |   const s = "}";
```

The same problem occurred with braces in comments. A larger chunking fixture caused the chunk for `f` to extend across the following function, producing a chunk range of the entire file rather than the function body.

The parser has solved the hard part, but the integration still throws away its source range and reconstructs it with the old unreliable method.

**Required fix:** carry parser start and end positions through the normalized symbol record, or expose a range side table keyed by symbol identity. Make `ast_search`, `read(symbol=...)`, and `chunkFile()` consume that range. Keep line-based indentation only for languages that genuinely require it and for the explicit parser-fallback path.

### 4. High severity: the visitor indexes locals, nested declarations, and object methods

The Tree-sitter visitor recursively walks every named child and emits records for declarations wherever they occur. It does not stop at function bodies or distinguish file-level declarations from local declarations.

Observed output for a class method included:

```text
A                 class
method            method
localValue        variable
nestedFunction    function
objectValue       variable
nestedObjectMethod method
```

The object-literal method was classified as a class-style method even though it was not a class member.

This affects all consumers that describe symbols as repository structure:

- `extractDocumentSymbols()` is documented as returning top-level symbols but now includes locals;
- `computeRepoMap()` can spend its small token budget on local implementation variables;
- `chunkFile()` creates chunks for local variables and nested methods;
- BM25 indexing gets more low-value records and more duplicate context.

The impact is measurable on the current workspace:

```text
extractFileTags definitions before parser:  2,445
extractFileTags definitions after parser:   2,800
increase:                                      355

chunkWorkspace chunks before parser:        2,437
chunkWorkspace chunks after parser:         2,789
increase:                                      352
```

The repository-map output after initialization visibly contained local implementation variables such as `collected`, `parenDepth`, `start`, and `end` near the top of the map. That is the opposite of a compact orientation map.

**Required fix:** define the symbol scope policy explicitly. For the current tool contract, the likely minimum is:

- file-level functions, classes, interfaces, types, enums, aliases, and variables;
- class or interface members where member lookup is requested;
- no declarations inside function bodies;
- no object-literal methods unless a separate query explicitly asks for them.

The visitor should use parent and scope checks instead of recursively treating every matching node as a repository symbol.

### 5. Medium to high severity: extraction is incomplete and metadata is inconsistent

The current visitor recognizes only a subset of grammar node types and applies several branches without enough language-specific qualification.

Observed TypeScript and JavaScript gaps include:

- `enum State { ... }` produced no definition;
- `var value = ...` produced no definition;
- `export var value = ...` produced no definition;
- interface method signatures and fields were not emitted as members;
- namespaces were not emitted as namespace symbols, while declarations inside them were promoted as if they were top-level;
- `const F = function named() {}` was classified as a variable rather than a function;
- `export abstract class A {}` produced no class definition;
- `declare function f(): void` produced no function definition.

Other observed cross-language issues include:

- a decorated Python class method was classified as a function rather than a method because the direct-parent test did not account for the decorator wrapper;
- multiline Python `from module import (name as alias)` was not emitted as an alias after Tree-sitter took over, so the existing aliased re-export behavior can regress in a real eagerly initialized session;
- C++ class methods were classified as functions rather than methods;
- Rust traits and enums were normalized to `class`, and Go interface types were also normalized to `class`;
- Rust, Go, and Python alias extraction is not covered by the new parser test.

Some normalization choices may be intentional, but the current `SymbolDef.kind` values no longer consistently describe the grammar construct that produced them. The existing `ast_search` API advertises `enum`, `trait`, `struct`, and `method`, so these distinctions should either be implemented or documented as deliberate compatibility aliases.

### 6. Medium severity: malformed syntax is accepted without a degraded-parser signal

Tree-sitter's error recovery is useful, but the implementation never checks `rootNode.hasError` and does not mark results as recovered or uncertain.

A malformed TypeScript fixture produced records including:

```text
Broken   class
method   method
after    method
```

The top-level `function after()` was classified as a method because the recovery tree placed it under the damaged class structure.

For a user asking an exact structural query, silently returning a recovered and incorrectly scoped declaration is worse than reporting that structural search is degraded.

**Required fix:** decide and test a policy. Options include:

- return valid local records but attach a degraded-parse status;
- suppress records under error nodes;
- or fall back to a clearly labelled heuristic result only when exact structure is unavailable.

Do not describe malformed recovery output as definitive AST structure without qualification.

### 7. Medium severity: references are still a regex scan, not AST data

The new parser uses Tree-sitter for declarations but builds `FileTags.references` with:

```text
/\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/g
```

That scan includes identifiers found in comments and strings. A test source containing a fake method in a comment and fake class text in a string produced references such as `fakeMethod`, `fakeClass`, and `fake`, even though none was code usage.

`FileTags.references` feeds repository-map file relationships and PageRank. The declaration side is structural, but the graph side remains polluted by prose and literals.

**Required fix:** collect references from grammar identifier nodes, or at least use a language-aware token stream that excludes comments and string literals. If full reference extraction is not worth the complexity, keep references conservative rather than calling the whole `FileTags` result AST-derived.

### 8. High severity for performance claims: all grammars load eagerly

`src/index.ts` starts Tree-sitter initialization for every extension session, regardless of the selected retrieval profile or the languages present in the workspace. The engine loads 20 parser extensions backed by 14 WASM language assets.

Observed in this Windows Node environment:

```text
TreeSitterEngine initialization: approximately 126 to 139 ms
fresh process RSS before initialization: approximately 65.6 MB
RSS after initialization:                  approximately 139 MB
```

The exact memory values include the TypeScript loader and runtime, so they are not universal benchmarks. They do show that the parser is not a zero-cost startup feature.

Warm parser operations were reasonably fast for tiny inputs. One thousand small parses took approximately 66.9 ms. Workspace operations were different:

```text
computeRepoMap after parser initialization: approximately 242 to 354 ms
searchAstSymbols after parser initialization: approximately 264 to 278 ms
```

This is materially slower than the previous fallback measurements in the same workspace, which were roughly 45 to 65 ms for the repository map. The parser gives better structure, but the current implementation pays the cost on every full scan and adds startup memory even when the user remains in lean mode.

Lean mode still avoids the embedding model, but the README and status language should not imply that the whole retrieval engine adds zero memory or zero startup overhead after this change.

**Required fix:** load only grammars needed by the workspace, or initialize the parser lazily on the first structural operation. Benchmark cold startup, warm exact lookup, full repository mapping, and repeated searches separately. Add a parser-ready status so the fallback period is visible instead of silent.

### 9. High release risk: LSP binaries now target the extension directory

`src/lsp/lsp_registry.ts` changed `PI_LSP_BIN_DIR` from a directory below the Pi home to a path derived from `__dirname`:

```text
<extension>/bin/lsp
```

The current repository has no `bin/lsp` directory, so the function resolves to the extension directory's `bin/lsp` path. `src/lsp/lsp_installer.ts` still says `~/.pi/lsp/bin` in its comments and still calls `ensureLspBinDir()` through the renamed constant. `PI_LSP_CONFIG_FILE` remains under the Pi home, so binaries and configuration now use different storage roots.

No installer was executed during the audit because that would be an external installation action. The code-level risk is clear:

- npm package directories are not guaranteed to be writable;
- a globally installed extension may be read-only or replaced during package upgrades;
- the new `bin` directory is not part of the package `files` list and is created after installation;
- the installer documentation is now false;
- existing binaries in the old user directory may stop being found.

**Required fix:** keep downloaded or installed servers in a user-writable Pi-managed directory, or make the package-local directory an explicit opt-in with permission checks and a user-directory fallback. Add tests for fresh package paths and existing installations.

### 10. Medium release risk: `typebox` became a peer dependency

The current package places `typebox` in `peerDependencies` and `devDependencies`, while runtime tool modules import it directly. It was previously a normal package dependency.

That can be valid if Pi always supplies the peer, but a clean package installation was not tested. A Pi package loader or isolated package installation may not resolve peer dependencies in the same way as the development workspace.

**Required fix:** verify a clean install and actual Pi load without the repository's `node_modules`. If the extension owns the runtime import, keeping `typebox` in `dependencies` is the safer distribution contract unless the Pi host explicitly guarantees it as a peer.

### 11. Medium severity: the new test does not test the risky boundaries

Section 36 covers 11 language examples and checks that one expected symbol exists for each. It does not test all 20 active extensions or the failure modes introduced by this architecture.

Missing coverage includes:

- `.tsx`, `.jsx`, `.mjs`, `.cjs`, `.h`, `.hpp`, `.cc`, and `.cs` as distinct cases;
- TypeScript enums, `var`, ambient declarations, abstract classes, namespaces, interface members, function expressions, and aliases;
- Python decorated methods and multiline aliases;
- C++ class-member classification;
- nested functions, local variables, object-literal methods, and fields as negative cases;
- braces in strings and comments for `read(symbol=...)` and chunk ranges;
- malformed syntax and `rootNode.hasError` policy;
- Tree deletion and repeated-parse memory behavior;
- parser initialization before and after index synchronization;
- old search-cache invalidation after a tagger change;
- clean package installation and the LSP binary path.

The test runner places Section 36 at the end of the suite. That means earlier sections exercise the heuristic extractor before the Tree-sitter singleton is initialized, while a real extension session starts Tree-sitter in the background immediately. This ordering hides several integration regressions.

### 12. Documentation and benchmark claims are stale for the new path

The README still reports measurements based on approximately 45 source files and approximately 92.8k raw tokens. The current repository traversal found 83 files for the repository-map path and 94 files for the chunking path.

The README table also reports approximately 40 ms for repository-map computation, less than 1 ms for targeted symbol reads, and zero background RAM for lean retrieval. The parser-ready measurements above do not support those figures for the current eager Tree-sitter path.

The documentation also describes the system as `Tree-Sitter AST` immediately, although the synchronous API uses the old heuristic fallback until asynchronous initialization completes. It says AST search bypasses comments, strings, and documentation, which is substantially true for declaration records on supported files after initialization, but not for the `references` set used by PageRank.

**Required fix:** rerun benchmarks after the final lifecycle and range implementation. Record environment, cold versus warm state, parser readiness, file count, and whether the measurement includes package initialization. Update the README only from those measurements.

## Token-efficiency assessment

The result is mixed rather than a clear success or failure.

### Where it saves tokens

- A real parser removes many comment and string false positives from declaration search.
- Exact method lookup can avoid a broad file read when the parser is ready and the index is current.
- Normalized signatures are compact for ordinary declarations.
- WASM grammars avoid asking the model to infer structure from raw source.
- Existing output limits, deduplication, and bounded previews still work.

### Where it spends or wastes tokens

- Recursive traversal emits locals and nested declarations that do not belong in a compact repository map.
- The current workspace gained roughly 14 to 15 percent more definitions and chunks after parser initialization.
- A 1024-token repository map can be filled with local variables instead of high-value classes, methods, and module-level functions.
- Broken downstream ranges can return truncated method bodies or chunks that contain adjacent symbols, forcing follow-up reads.
- Stale fallback caches can make the model repeat searches because the newly supported method is absent.
- The parser does not add a separate readiness or degraded-result status, so the model cannot distinguish exact structural output from fallback output.

**Conclusion for token efficiency:** the parser direction supports the goal, but the current scope policy and stale-cache behavior prevent the implementation from fulfilling it consistently.

## Maximum-performance assessment

The implementation is fast enough for small warmed parser calls, but it does not currently meet a maximum-performance claim for the whole extension.

The main costs are:

- approximately 126 to 139 ms eager startup initialization;
- approximately 73 MB observed process RSS increase in the measured runtime setup;
- loading every language grammar even when unused;
- reparsing every file for each full repository map or AST search;
- no parsed-tree or tag cache separate from the search-chunk cache;
- native Tree leaks on every parse;
- workspace scans that still use separate raw reads and raw brace scans after parsing.

A more accurate claim would be: "grammar-backed structural retrieval with bounded output and low warm per-file parse cost, subject to workspace-size and parser-initialization overhead." The stronger phrase "token efficient, yet maximum performance" is not supported by the current measurements or correctness behavior.

## Recommended order of work

### P0 before treating the update as reliable

1. Release every parsed Tree in `finally`.
2. Make parser readiness part of index lifecycle, not an invisible background race.
3. Version search caches by extractor/tagger generation and force reindex after this change.
4. Propagate parser source ranges into symbol reading and chunking.
5. Define and enforce the scope policy that excludes function-body locals and object-literal methods from repository symbols.

### P1 before a public release

1. Add exact negative and malformed-syntax tests.
2. Fix or document missing declaration kinds and cross-language alias behavior.
3. Replace regex references with parser-derived identifiers or label the graph as lexical.
4. Load grammars lazily or per workspace language.
5. Restore a user-writable LSP installation directory or implement a tested fallback.
6. Verify a clean package installation with the peer-dependency arrangement.

### P2 before updating public performance claims

1. Rerun benchmarks with the parser initialized and with a cold process.
2. Measure memory after repeated parse, AST search, repository-map, and reindex cycles.
3. Measure token counts after filtering locals and nested declarations.
4. Update README numbers and state the environment and measurement method.
5. Add a cache migration test and a fresh Pi package smoke test.

## Final judgment

The update has a strong core idea and fixes the original TypeScript method-extraction problem in the happy path. The choice of Tree-sitter WASM is more defensible than adding another regex scanner, and the package remains reasonably distributable because the grammars are local and compressed well.

It is not ready to claim reliable structural symbol extraction across the supported languages. The parser resource leak, startup/cache race, discarded source ranges, scope pollution, and eager all-language initialization are concrete implementation flaws, not theoretical concerns.

It partially fulfills the token-efficiency philosophy and does not yet fulfill the maximum-performance claim. Fixing the five P0 items would provide the largest improvement with the smallest architectural change. No further language expansion should happen before those integration boundaries are corrected.
