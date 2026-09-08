# 01. The repo map mis-oriented me on cold start

## What I struggled with

I opened the session, ran `get_repo_map` (default ~1k tokens), and was shown
three files: `src/tui.rs`, `src/circuit_breaker.rs`, and `src/logging.rs`. The
top-ranked symbols inside `src/tui.rs` were **fourteen `Color::Rgb(...)`
palette constants** — `LIME`, `SKY`, `LAVENDER`, `MAUVE`, `PEACH`, etc.

This is a backend proxy gateway. Its actual hot paths are:

- `src/routes/proxy.rs` (748 lines, the catch-all request handler)
- `src/translation.rs` (~1062 lines, OpenAI ↔ Anthropic body translation)
- `src/upstream.rs` (~970 lines, retry/failover/circuit-breaker logic)
- `src/streaming.rs` (SSE passthrough)
- `src/loop_guard.rs` + `src/loop_recovery.rs` (loop detection + continuation)

None of those appeared in the default-budget map. At 3000 tokens, the map still
omitted `src/routes/proxy.rs` and `src/translation.rs`. I had to recover by
running `bash ls src/` and `wc -l src/**/*.rs` to discover what was actually
in the repo.

This cost me several round-trips before I even knew what files existed. Worse,
it actively sent me in the wrong direction — I would have started in `tui.rs`,
learning about Catppuccin Mocha palette styling, when the user's first three
questions were about translation, timeouts, and protocol support.

## Measured cost in this session

I made 2 `bash` discovery calls (`ls src/` and `wc -l src/*.rs`) to recover
what `get_repo_map` should have shown me. Total cost: ~500 chars and
2 tool calls. Real but small in absolute terms.

The bigger cost is *qualitative*: the misleading map sent me toward
`src/tui.rs` for orientation when the actual entry points
(`src/routes/proxy.rs`, `src/translation.rs`, `src/upstream.rs`) are the
real hot paths. The first 5+ tool calls of the session went to files
that weren't the answer to the user's questions.

## Why

PageRank over the AST is ranking raw declaration density. `tui.rs` has its
constants at the top of the file with trivial public visibility, so they win
on incoming `use` edges. There is no weighting by call-graph centrality, no
filter for "data" symbols (color palettes, regex statics, constant tables),
and no guarantee that the actual entry points (`main.rs`, `routes/mod.rs`,
`lifecycle::startup`) are included.

## What would satisfy my workflow

1. **Always include the entry point.** `src/main.rs`, `src/routes/mod.rs`,
   `src/lib.rs`, or whatever the crate root is — find it by searching for
   `fn main(` or `pub fn router(` and pin it as the top result regardless of
   PageRank.
2. **Filter trivial declarations out of the ranked list by default.** Constants
   whose type is `Color::Rgb`, regex `LazyLock<Regex>`, MIME-type tables,
   small enums — these don't help with orientation. Demote them to a
   collapsible "data" section or skip them unless the budget is generous.
3. **Use call-graph edges, not declaration density.** You already have a
   Tree-sitter index; you can compute "how many other public functions in the
   crate reference this symbol" cheaply. That's what PageRank *should* be on
   a code map.
4. **Surface a flat file list alongside the ranked map.** When I'm new to a
   repo, "here are the 17 files in `src/`, sorted by line count" is the most
   useful artifact. I can get this from `bash ls` but I shouldn't need bash for
   it.

## Smallest change that would help today

Even without fixing PageRank: guarantee that the top result of `get_repo_map`
is the entry-point function (`startup` in `lifecycle.rs`, `router` in
`routes/mod.rs`). That alone would have saved me three tool calls.