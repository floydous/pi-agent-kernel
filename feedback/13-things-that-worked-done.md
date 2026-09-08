# 13. Things that worked well and should not change

- **`code_search`'s chunked output with file:line headers and AST-bounded
  snippets is genuinely useful.** When my query contained real identifiers
  or domain words ("cache_control ephemeral", "retry rate limit 429"), the
  top result was almost always exactly what I needed. Don't touch the
  chunking or the AST-boundary slicing — they're the reason this tool is
  good. The ranker behavior is the thing to fix, not the chunking. See #4.
- **`read` with `symbol` extraction is fast and reliable.** Better than
  paging through 950-line functions to find the signature.
- **`get_repo_map`'s budget control is a good idea** — the problem is the
  ranking, not the budget knob. See #1.
- **The dedup system on identical tool calls is correct** and not
  overzealous. The `[=rN,sizeB,...]` references save real tokens on
  repeated calls without suppressing useful variation.
- **The edit-before-read guard is now content-aware.** It tracks which
  lines are in my context and blocks edits to lines I haven't seen. This
  is the right safety model. See #8 for the one remaining gap (`ast_search`
  not being a read-substitute).
- **`lsp references` produces rich results now.** After the package
  install, a single reference query returns 7 call sites with
  `file:line:column` and inline call text, which is what a real reference
  query should produce. Don't regress this.
- **`lsp document_symbols` (single file) is an under-promoted gem.** When
  I'm oriented on one file, it's faster than `get_repo_map` and shows
  line numbers cleanly. Promote it.
- **`rrf_k` on `code_search` is observably active.** Different values
  produce different result lists and orders. Don't remove the parameter.