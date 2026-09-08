# 04. `code_search` — high cost, low signal density, summary mode is the fix

## What I struggled with

I trusted the description ("hybrid BM25 and semantic ranking across AST-bounded
code chunks") and asked natural-language questions. The first two probes:

- `"completely unrelated topic database postgres connection"` → matched loop-guard
  unit tests because the tests contain the words "topic", "step", "subject matter".
- `"the quick brown fox jumps"` → matched drift-loop tests for the same reason.

Neither query had any semantic relationship to the loop-guard test files, but
both surfaced them because the ranker is keyword-driven, not semantic.

I also tried the `rrf_k` parameter at values 1, 60, and 200 on the same query
and (at the time) got identical results in identical order — evidence that
the parameter was not connected to any ranker.

## What's now true after the package install

After the user told me the retrieval engine wasn't fully wired, and the
relevant packages were installed, I re-tested. The picture now is:

- **`rrf_k` is now observably active.** Running the same `code_search` query
  with `rrf_k: 1` vs `rrf_k: 200` produced different result lists in
  different orders. A particular `shutdown` call site in `src/lifecycle.rs`
  appeared at `rrf_k: 200` but not at `rrf_k: 1`. So the parameter does
  something — the ranker is alive.
- **The ranker is still keyword-driven, not semantic.** The same
  "completely unrelated topic database postgres connection" query that
  failed the semantic-discrimination test in the previous session still
  returns the same irrelevant top result (a markdown file containing the
  words "topic" and "step") even with packages installed. Switching
  `rrf_k` reshuffles results, but the top of the list is still dictated
  by literal keyword overlap.
- **Markdown files can win over code.** I wrote `feedback/04-...md` and
  then queried the codebase; my own markdown feedback file consistently
  appeared at the top of `code_search` results because the words "topic",
  "step", "subject matter" appear in the section about loop-guard tests.
  Prose embeddings appear to be richer than sparse code tokens, so any
  prose file in the index can outscore actual code on a keyword-heavy
  query.
- **The retrieval engine (`dense-768d` vs `BM25`) has no observable effect
  on `code_search` results.** Switching the engine and re-running the same
  query produced byte-identical results, dedup'd together. So even with
  the ranker now alive, the engine setting doesn't reach the tool.

## Measured cost in this session

From the actual session log:

- `code_search` was called **38 times**, producing **419,638 chars of
  output** — **64% of all tool output** in the session.
- The mean result was 11,043 chars; the largest was 34,706 chars across
  5 chunks in 2 files.
- 11 of 38 calls (29%) were duplicates of earlier queries, wasting
  ~101k chars of output.

So `code_search` is *the* cost bottleneck. A summary-mode default would
target the largest cost in the toolkit.

## Concrete proposal: `code_search` summary mode

Add a `mode` parameter that defaults to summary for queries with >2
matches, full for ≤2:

```typescript
code_search(query, options?: {
  mode?: "summary" | "preview" | "full"  // default: "summary" if matches > 5, "preview" if 2-5, "full" if ≤1
  max_chunks?: number                     // default: 8
  rrf_k?: number                          // default: 60
})
```

**Three output formats, ordered by size:**

- **Summary** (~150-500 chars per result): file:line + kind + symbol name + 1-line headline. No body.
- **Preview** (~150-500 chars per result): file:line + first 5-10 lines of the body. Just enough to confirm relevance.
- **Full** (current behavior, ~3-10k chars per result): complete body preview.

**The right default depends on the number of matches:**

## Distribution of result sizes (measured)

From the 38 `code_search` calls in this session:

- **17 calls (43%)** returned <5k chars. Summary mode saves little here.
- **14 calls (35%)** returned 5-20k chars. Preview mode is the right
  call (~750 chars vs 11k mean).
- **9 calls (23%)** returned 20k+ chars. Summary mode is the big
  win (~500 chars vs 30k max).

If the 9 large-result calls had been summary mode (~500 chars each)
instead of full, and the agent had done 1-2 follow-up `read`s per
result (~1.5k chars each), the net saving would be:

- Original: 9 × ~25k = ~225k chars
- With summary + reads: 9 × (500 + 1.5 × 1.5k) = ~25k chars
- **Net saving: ~200k chars** for those 9 calls.

That matches the 30% total session saving estimate.

## Why three modes, not two

- **Summary only** is great for navigating to the right chunk, but
  for queries like "find me the function that does X", you still need
  to read the function to confirm it's the right one. Summary requires
  a follow-up `read` per match.
- **Preview** (5-10 lines per match) is the sweet spot: enough text to
  see "this is a markdown file, skip" or "this is a function I want to
  dig into", without drowning the agent in 30k chars of body.
- **Full** is the right default for 1-match queries where the body is
  the answer the agent is looking for.

A reasonable default ladder: 1 match → full, 2-5 matches → preview,
6+ matches → summary.

**Example preview output:**

```
src/translation.rs:22-362  function: translate_anthropic_to_openai
  // ─── Anthropic → OpenAI ─────────────────────────────────────────────
  /// Translate Anthropic API JSON body → OpenAI API JSON body.
  /// Handles: system prompts, text messages, tool definitions, tool_use
  /// blocks (assistant tool calls), tool_result blocks (user tool responses),
  /// ephemeral/cache_control blocks, thinking blocks, and extra content types.
  pub fn translate_anthropic_to_openai(...)

src/translation.rs:412-950  function: stream_openai_to_anthropic
  // ... next 7 lines of the function header ...

src/translation.rs:1000-1027  test: cache_control_does_not_bleed
  // ... first 7 lines of the test ...
```

The agent sees just enough to decide which matches to drill into.

## Token impact estimate

- **For multi-result queries (most of my `code_search` calls):**
  Preview mode replaces ~11k chars with ~750 chars. **~15x reduction.**
- **For 1-result queries:** Full mode unchanged. No cost.
- **For 6+ result queries:** Summary mode replaces ~30k with ~500.
  **~60x reduction.**
- **Follow-up `read` calls are smaller and more focused** because the
  agent has already confirmed relevance from the preview.

**Estimated session-level savings:** ~200k chars (30% of all output).

## Workflow impact

Current workflow for a multi-result query:
1. `code_search("query")` → 11k chars, agent skims, picks relevant chunk
2. `read(file, symbol=X)` → ~1-2k chars
3. Maybe `read(file, symbol=Y)` → another ~1-2k chars
4. Total: ~13-15k chars across 3-4 calls

New workflow with summary default:
1. `code_search("query")` → 150 chars, agent has the file:line list
2. `read(file, symbol=X)` → ~1-2k chars
3. `read(file, symbol=Y)` → another ~1-2k chars
4. Total: ~2.5-4k chars across 3-4 calls

**~3-4x reduction in tokens for the same logical question.** The agent's
context is tighter, the answer is more accurate (no skimming, just
surgical reads), and the dedup system has less to compare.

## Other things that would also help (lower priority)

1. **Exclude `*.md` and other prose files from the index** (or weight
   them by file extension). Markdown files can outscore code on
   keyword-heavy queries.
2. **Surface the active engine in the response header.** `[engine:
   dense-768d]` lets users verify the switch happened.
3. **Make the engine setting reach the tool.** Currently the engine
   appears to have no observable effect on `code_search`.

## Smallest change that would help today

Implement `code_search` summary mode with the default behavior described
above. Single change, server-side, benefits every user immediately.