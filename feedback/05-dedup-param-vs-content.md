# 05. Dedup keys on tool params, not content — exact repeats are solved; near repeats are not

## Factual re-test

The repository's dedup store is deliberately keyed by:

```text
rendered content hash + tool name + stable parameter hash
```

Using the same rendered result for every call produced this matrix:

| Call | Parameters/tool | Current result |
|---|---|---|
| 1 | `code_search`, `{query:"q", limit:5}` | first occurrence |
| 2 | same tool and parameters | dedup hit (`r1`) |
| 3 | same tool, `limit:10` | new result/ref |
| 4 | same tool, `query:"q2"` | new result/ref |
| 5 | `read`, `{path:"a"}` | new result/ref |

That behavior is factual and intentional. It prevents a `read` result from
being confused with a `code_search` result and avoids treating changed ranges,
limits, scopes, or modes as interchangeable. Compaction safety is also tested:
a prior reference is not reused after the context has been compacted.

A call-ID-aware audit of the original Gateway log found byte-identical
`code_search` output for calls whose parameters differed (`rrf_k`, path spelling,
scope, and query expansion). In that log there were 63 result records, seven
same-output groups, and 57,162 characters in later same-output occurrences.
Exact parameter repeats accounted for seven later calls and 28,180 characters.
Those numbers are session-specific and differ from the older 38-call estimate in
this file's previous version.

The current extension-research session is smaller in search volume: 28
`code_search` calls, five Jaccard-near query pairs, and 29 exact duplicate calls
across all tools. This confirms repetition, but does not prove that near queries
are safe to merge.

## Why the proposed Jaccard merge is unsafe by default

A query such as `save state` versus `save state file path` can legitimately
change intent. A changed `scope`, `file_pattern`, `limit`, retrieval profile,
or index freshness can also change the result. Returning an old result without
running the new query risks silently hiding new matches. A token-set threshold
cannot know whether an added word is a constraint or harmless elaboration.

## Workflow comparison

**Current safe workflow:** issue the new query; exact byte-identical repeats with
identical tool and parameters become `[=rN,...]`; use `recall` only when the
original is no longer visible.

**Proposed semantic-cache workflow:** compare recent query tokens, return an old
result for a similar query, and optionally merge new matches. This saves a call
only when the similarity heuristic is correct, but creates a silent false-negative
failure mode when it is not.

**Measured conclusion:** exact content reuse is already implemented. A safe
near-query experiment needs a labeled workload with intent-preservation and
recall metrics; no such held-out evaluation exists here.

## Verdict

**The problem exists for exact byte-equivalent results with changed parameters,
but automatic semantic query clustering is not yet justified.** The smallest
safe improvement is observability: report when an exact content match was not
deduped because the tool/parameters differed, or expose a user-requested
`reuse_ref`/preview operation. Do not merge Jaccard-near searches into normal
search results until a held-out workload measures false-positive intent merges.

## Headroom/Manus comparison

Headroom uses reversible hash-keyed retrieval and automatic dedup while keeping
the original available through CCR. Manus emphasizes deterministic,
append-only context and warns that modifying prior observations can damage cache
reuse. Those methods support the current exact/content-addressed policy: preserve
identity and freshness, compress or retrieve backing data, and avoid opaque
semantic substitution.
