# Retrieval

Retrieval is implemented in `src/retrieval/` and is intentionally layered so
fast discovery does not require loading the local embedding model.

## Components

- `workspace_walker.ts` provides unified, `.gitignore`- and `.piignore`-aware filesystem traversal shared across indexing, repository maps, and AST search with directory pruning and child negation.
- `repomap.ts` extracts AST symbols and produces a ranked repository map.
- `ast_search.ts` provides structural symbol search and language-aware fallback
  operations such as document symbols, references, and local hover details.
- `search_chunker.ts` creates syntax-aware chunks with breadcrumbs.
- `search_bm25.ts` provides the fast lexical search path.
- `search_embedder.ts` provides optional local embeddings.
- `search_index.ts` coordinates indexing, incremental file updates, profiles, and fallback behavior.
- `search_modal.ts` exposes profile controls in the Pi UI.

## Profiles

- `lean`: AST-aware BM25 search with minimal startup cost.
- `hybrid`: BM25 combined with local embeddings when available.
- `full`: the highest-cost configured retrieval profile.
- `off`: disables retrieval indexing where supported.
- `auto`: lets the runtime select the configured/default profile.

During indexing, search can fall back to the lean path rather than blocking on
model initialization. Hybrid/full profiles require vector cosine similarity of at
least 0.6 before candidates enter reciprocal-rank fusion; lower-confidence vector
candidates are abstained from while BM25 results remain available. This floor is a
conservative initial boundary measured on the bounded feedback fixture and must be
recalibrated against a larger labeled corpus before changing it. Output limits
remain enforced so retrieval cannot flood agent context.

AST and code-search path filters match normalized relative path substrings
(including directory fragments, filenames, and extensions). `includeBody` returns
a bounded preview of up to 25 lines; when the preview is truncated, the AST
result marks it as truncated; use the targeted symbol reader for the complete
implementation. `code_search` reports whether each result is `lexical`, `semantic`,
or `hybrid`, and accepts an optional bounded RRF smoothing constant from 1 to 200.
The default remains 60.
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
