# 09. `code_search` chunks split mid-statement, not at semantic boundaries

## What I struggled with

The `code_search` tool description claims "AST-bounded code chunks", but in
practice the splits don't track AST structure. I've seen chunks that start
in the middle of a `match` arm, end inside a long literal, or break a
function in half at roughly file-size boundaries rather than at the closing
brace of the function.

Concrete examples from this session:

- `stream_openai_to_anthropic` (412-950) — a 538-line function — was
  sometimes surfaced as a single chunk and sometimes as multiple chunks,
  but the multiple-chunk case didn't respect function boundaries; it just
  hit a size cap.
- `translate_anthropic_to_openai` (22-362) — a 340-line function — the same
  pattern. When the chunking fired, the break point was at line ~190, which
  is mid-function (inside the messages loop, after a `match` arm).
- The visible chunk header (`src/translation.rs:22-362 [function]
  translate_anthropic_to_openai`) suggests the boundary *is* at the function,
  but the body preview I saw sometimes stopped at a much earlier line. So
  the metadata and the body are inconsistent — I can't trust the line range
  in the header to tell me what's actually in the chunk.

The practical cost: when a chunk is mid-statement, I have to `read` the full
file to see the rest. The chunk was supposed to save me that step.

**However:** if the summary mode proposal (see #4) is implemented, this
problem largely dissolves — the agent would no longer be reading chunk
bodies directly, just file:line lists. The chunk-boundary issue is
really only a problem for full-mode queries, which would become the
minority.

## What would satisfy my workflow

1. **Make chunks respect AST boundaries.** Functions, structs, enums,
   top-level impls, and trait declarations should never be split. If a
   function is too large to fit in one chunk, the chunk header should say
   `[function foo, lines 22-180 of 22-340, more available]` so I know the
   body is truncated rather than complete.
2. **Make chunk headers and chunk bodies agree.** The `22-362` line range
   in the header should match what's actually in the body preview. If a
   chunk is truncated, the header should reflect that.
3. **Add a `complete: bool` flag** (or similar) to each chunk so the agent
   can tell at a glance whether what it has is the whole thing or a slice.

## Smallest change that would help today

Stop splitting inside a single function body. If a function exceeds the chunk
size cap, emit one chunk for it marked as truncated, and continue from the
next top-level item. That's a one-line policy change and immediately removes
the worst class of mid-statement splits.