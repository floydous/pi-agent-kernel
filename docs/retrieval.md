# Retrieval

Retrieval is implemented in `src/retrieval/` and is intentionally layered so
fast discovery does not require loading the local embedding model.

## Components

- `workspace_walker.ts` provides unified, `.gitignore`- and `.piignore`-aware filesystem traversal shared across indexing with directory pruning and child negation.
- `tag_extractor.ts` extracts syntax-aware AST symbol definitions and test-path classifications for code chunking and semantic search.
- `search_chunker.ts` creates syntax-aware chunks with breadcrumbs.
- `search_bm25.ts` provides the fast lexical search path.
- `search_embedder.ts` provides optional local embeddings.
- `search_index.ts` coordinates indexing, incremental file updates, profiles, and fallback behavior.
- `search_modal.ts` exposes profile controls in the Pi UI.

## Profiles

- `lean`: AST-aware BM25 search with minimal startup cost.
- `full`: BM25 fused with 768-dimension embeddings from the local
  `Alibaba-NLP/gte-modernbert-base` code embedder (q8, ~147 MB, pinned revision).
  `hybrid` is accepted as an alias for `full`.
- `off`: disables retrieval indexing where supported.
- `auto`: selects `lean` below 4 CPU cores and `full` otherwise.

During indexing, search can fall back to the lean path rather than blocking on
model initialization. The full profile requires vector cosine similarity of at
least 0.45 before candidates enter reciprocal-rank fusion; lower-confidence vector
candidates are abstained from while BM25 results remain available. The floor is the
highest one that dropped no top-5 hit on 168 held-out queries (`DENSE_SIMILARITY_FLOOR`
in `search_config.ts`); recalibrate it whenever the embedding model changes. Vector
caches are tagged with the model and revision that produced them, and caches from
another model are re-embedded rather than reused. Output limits remain enforced so
retrieval cannot flood agent context.

The `code_search` index covers source code and HTML files (`.html`, `.htm`): HTML files are chunked into structural DOM groups with leaf-control rollup, parent suppression, and inline `<style>`/`<script>` boundaries. Markdown and configuration files (JSON, YAML, TOML, CSS) remain readable but are not chunked or embedded for retrieval.

Code-search path filters match normalized relative path substrings
(including directory fragments, filenames, and extensions). `code_search` reports
whether each result is `lexical`, `semantic`, or `hybrid`, and accepts an optional
bounded RRF smoothing constant from 1 to 200. The default remains 60.
Vector caches are accepted only when their metadata, chunk IDs, dimensions, byte
length, and content hash agree; invalid vector data is ignored while the BM25
index remains usable.

## Workspace Traversal & Ignore Rules

Traversal walks workspace directories hierarchically using `workspace_walker.ts`:
- `.gitignore` and `.piignore` rules are evaluated with standard precedence, including directory pruning (`dir/`), wildcard descent (`dir/*`), and child negations (`!keep.ts`).
- Traversal strictly rejects symlinks and escapes outside workspace boundaries.
- Ignore configurations are tracked in dedicated snapshot metadata (`ignoreConfigHashes`). Modifying ignore files evicts newly ignored source chunks on the next query without counting phantom files.

## Incremental Updates & Profile Switching

- **Incremental File Updates (`updateFile`)**: When a file is modified, only that file's AST chunks are re-parsed. Unchanged chunks reuse existing dense vectors by content hash across line shifts, avoiding full-repository re-embeddings.
- **In-Flight Cancellation**: Switching retrieval profiles (e.g. `hybrid` -> `full`) while background indexing is running immediately aborts in-flight embedding jobs via generation counters and `AbortController`. Stale vectors are rejected post-await, and the statusline switches directly to tracking the new profile.
- **Debounced Persistence**: Sequential mutations are coalesced into debounced atomic writes (`scheduleDebouncedSave`) and flushed cleanly on session shutdown (`flushPendingSave`).
