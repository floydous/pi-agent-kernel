# 16. The biggest cost in `code_search`: markdown files outranking code

## What I struggled with

I had 4 of my top 5 `code_search` results be markdown files I wrote
myself. The same pattern reproduces with this fresh probe:

Query: `"how does the model know when to stop hammering on a stuck thought pattern"`

Top 5 results, unfiltered:
1. `feedback/03-workspace-grep.md` — my own feedback file
2. `feedback/02-go-to-symbol.md` — my own feedback file
3. `feedback/11-no-timing-info.md` — my own feedback file
4. `src/config.rs:35-39` — `CONNECT_TIMEOUT` constant (unrelated)
5. `feedback/09-code-search-chunk-boundaries-done.md` — my own feedback file

The right answer (`src/loop_guard.rs::LoopDetector`) is buried at result
6 or later, after the agent has already waded through 4 unrelated
markdown files.

## How query-dependent the problem is

This isn't a constant issue. With a different query (no words
matching my feedback files), the markdown noise doesn't appear:

Query: `"streaming response body chunked transfer"`

Top 5 results:
1. `src/streaming.rs:466-518` — `passthrough_streaming` ✓
2. `src/routes/proxy.rs:421-459` — `dispatch_response` ✓
3. `src/config.rs:30-33` — `NONSTREAM_REQUEST_TIMEOUT` ✓
4. `src/upstream.rs:70-354` — `execute` ✓
5. `src/config.rs:66-85` — `EXCLUDED_HEADERS` ✓

All Rust code, no noise. The markdown-noise problem is **conditional on
whether the query words match text in any prose file in the index**. When
they do, prose wins; when they don't, code wins cleanly.

**The right framing:** the markdown-noise problem is a *keyword matching*
issue, not a *semantic understanding* issue. The ranker correctly finds
files whose words match the query. The problem is that prose files
contain more query-matching words than code files, even when the user
is asking about code.

This means the fix is **filter by file type, not "be smarter about
prose"**. Prose is a legitimate corpus; the agent just doesn't want it
when searching for code.

## Measured cost in this session

- 4 of top 5 `code_search` results were markdown noise.
- Each "noise" result is ~3-5k chars of the agent's context.
- 3 markdown files × ~3k chars = ~9k chars of pure context pollution per
  multi-result `code_search` call.
- Across the session, this is a substantial fraction of the 419k chars
  of `code_search` output.

## What would satisfy my workflow

Two complementary fixes:

### Fix A: Default-exclude prose files from `code_search`

Prose files (`.md`, `.txt`, `.rst`, etc.) should be excluded by default
from `code_search`. The agent can opt in with `file_pattern` if it
wants to search prose.

```typescript
code_search(query, options?: {
  file_pattern?: string      // explicit filter; "*" includes prose
  // (no other change needed)
})
```

### Fix B: `code_search` summary mode (see #4)

Even with Fix A, a multi-result query can return 5+ code chunks. The
summary mode (file:line + headline, no body) is the right default for
such cases.

## Why this is the highest-impact fix

In this session, the markdown-noise problem caused:

- 4 extra `read` calls to confirm markdown files were noise (each ~5k
  chars of context the agent had to read and dismiss)
- Wrong initial impressions (the agent thought the answer was in
  feedback files before realizing they were its own)
- Reduced trust in `code_search` results overall

The fix is one-line on the server: filter the index by file extension
by default.

## Token impact estimate

If the agent immediately sees only Rust code results:
- 4 noise results × 3-5k chars = 12-20k chars saved per `code_search`
  call.
- Across 38 `code_search` calls: ~150-300k chars saved (not all
  queries have markdown noise, but most multi-result queries in
  this session did).

**Estimated session-level savings:** 200-300k chars (30-45% of all
tool output). This is the single biggest fix in the entire feedback
doc.

## Smallest change that would help today

Server-side: filter `code_search` to code files (`.rs`, `.py`, `.ts`,
`.js`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`) by default. Add
`*` as a "search everything" escape hatch. One-line change with
massive impact.