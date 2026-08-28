# Retrieval

Retrieval is implemented in `src/retrieval/` and is intentionally layered so
fast discovery does not require loading the local embedding model.

## Components

- `repomap.ts` extracts AST symbols and produces a ranked repository map.
- `ast_search.ts` provides structural symbol search and language-aware fallback
  operations such as document symbols, references, and local hover details.
- `search_chunker.ts` creates syntax-aware chunks with breadcrumbs.
- `search_bm25.ts` provides the fast lexical search path.
- `search_embedder.ts` provides optional local embeddings.
- `search_index.ts` coordinates indexing, profiles, and fallback behavior.
- `search_modal.ts` exposes profile controls in the Pi UI.

## Profiles

- `lean`: AST-aware BM25 search with minimal startup cost.
- `hybrid`: BM25 combined with local embeddings when available.
- `full`: the highest-cost configured retrieval profile.
- `off`: disables retrieval indexing where supported.
- `auto`: lets the runtime select the configured/default profile.

During indexing, search can fall back to the lean path rather than blocking on
model initialization. Output limits remain enforced so retrieval cannot flood
agent context.
