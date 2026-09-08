# 14. Research findings — measured workflow, comparative methods, and decisions

This file records the experiments behind the feedback decisions. It separates
what was directly measured in this repository from historical measurements of a
separate OpenRouter Gateway session and from external methodology references.

## 1. Repository changes already implemented

The high-impact findings were tested against the extension's real tools and
implemented where the evidence was strong:

- `code_search` defaults to `scope: "code"`; `.md`, `.mdx`, `.txt`, and `.rst`
  remain searchable with explicit `scope: "prose"` or `scope: "all"`.
- Scope and `file_pattern` filters are applied before BM25/vector ranking, so
  excluded prose cannot displace code candidates.
- Automatic search output is adaptive and bounded; explicit `mode: "full"`,
  `"preview"`, and `"summary"` remain available.
- Repository-map output prioritizes entry-point anchors, includes file-size
  orientation, and demotes trivial data declarations.
- AST chunk spans and formatter metadata preserve bounded, query-focused
  previews.

The changes were verified with `npm run typecheck`, `npm test` (**36 passed,
0 failed**), and `git diff --check`.

## 2. Controlled retrieval/output experiment

The checked-in polyglot fixture contains 11 files and 110 AST chunks. Twelve
manually corrected conceptual queries were run against `lean` (BM25), `hybrid`
(BM25 + 256-dimensional Nomic embeddings), and `full` (BM25 + 768-dimensional
Nomic embeddings). The profile benchmark is small and not a universal accuracy
claim.

### Retrieval accuracy

| Profile | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|---:|---:|---:|---:|
| lean | 7/12 | 7/12 | 8/12 | 0.6258 |
| hybrid | 8/12 | 9/12 | 10/12 | 0.7369 |
| full | 7/12 | 10/12 | 11/12 | 0.7272 |

Hybrid had the best measured top result and MRR. Full had deeper recall, but
not better Recall@1 on this set.

### Warm/indexing cost on the same fixture

| Profile | Sync | Median query | P95 query | Vector bytes | Index bytes |
|---|---:|---:|---:|---:|---:|
| lean | 588.7 ms | 2.99 ms | 5.98 ms | 0 | 121,819 |
| hybrid | 30,191.7 ms | 0.74 ms | 3.71 ms | 112,640 | 126,305 |
| full | 29,839.7 ms | 1.34 ms | 4.28 ms | 337,920 | 126,083 |

Embedding model startup/caching dominates the vector synchronization numbers;
these are not production-wide cold-start claims. Hybrid is the recommended
vector trade-off from this fixture; the persisted lean profile remains available
when zero vector storage and fast indexing matter, while full remains explicit
when deeper recall matters.

### Adaptive output cost

A second 12-query run compared legacy full rendering with the implemented
adaptive formatter on the same fixture:

| Profile | Legacy chars | Adaptive chars | Reduction |
|---|---:|---:|---:|
| lean | 25,247 | 17,824 | 29.4% |
| hybrid | 29,666 | 18,263 | 38.4% |
| full | 30,452 | 18,194 | 40.3% |

This is output rendering only, not end-to-end model quality. Adaptive output
keeps a small number of query-focused previews and summarizes the rest; explicit
full mode preserves the legacy body for callers that need it.

## 3. Feedback-by-feedback experiments

### 02 / 10: composite navigation and bare-symbol goto

On `withConnection`, current `ast_search` plus `read(symbol)` returned 464
characters in two calls. A hypothetical composite can remove a round trip but
cannot reduce the same requested body/location payload. The Gateway session had
only one `ast_search → read` sequence (652 characters) and three
`ast_search → lsp` sequences (3,473 characters). Verdict: real ergonomics gap,
low token impact; keep any future composite bounded and opt-in.

### 03: workspace grep

Searching the literal `withConnection` on the fixture returned two locations
with 132 characters of bounded context. Native `rg` already provides this
workflow, and LSP references provide the semantic variant. Verdict: real
first-class-tool gap, low impact; do not duplicate ripgrep without a demonstrated
need for enclosing-AST context.

### 05: parameter versus content dedup

The exact matrix was measured against `DedupStore`: same tool + same params +
same content dedups; changing `limit`, query, or tool does not. The original
Gateway call-ID audit found 63 `code_search` results, seven same-output groups,
and 57,162 characters in later same-output occurrences; exact parameter repeats
accounted for 28,180 characters. This establishes wasted byte-equivalent output
with changed parameters, but not safe semantic equivalence. Verdict: retain
strict correctness; defer Jaccard merging until a labeled false-positive test
exists.

### 06: LSP fallback and shape

On the TypeScript fixture, symbol and coordinate inputs for definition, hover,
and references agreed when the cursor was on a meaningful identifier. Directory
diagnostics still fail with `EISDIR`. Verdict: the broad coordinate-bug claim is
not reproducible; provenance labels, response-shape consistency, and directory
handling remain narrow gaps.

### 07: exact read versus fuzzy AST search

`read("withConnectio")` fails; `ast_search("withConnectio")` finds
`withConnection`; a second exact read is needed. Verdict: confirmed but tiny;
bounded suggestions are safer than silent fuzzy extraction.

### 08: edit authorization

The guard experiment showed search evidence alone is blocked; reading lines
1–5 does not authorize an edit to lines 20–25; reading lines 20–25 does; an
external append then causes a fingerprint-drift block. Verdict: the old
content-blind report is obsolete; search must remain weaker than read evidence.

### 11: timing

Tool result bodies contain no standard timing footer. Independent local timing
showed lean indexing around 570 ms versus roughly 36.7–38.8 seconds for vector
profiles on the fixture. Verdict: real observability gap, but universal timing
belongs to host middleware; extension details can expose local operation timing.

### 15: read after write

The current extension-research log contained 16 writes and 8 later reads of a
previously written path, mostly temporary experiment scripts and test rewrites.
This is smaller than the historical Gateway claim and is not necessarily wasted:
read-back can verify filesystem state. The edit path already records the exact
post-edit snapshot and rejects external drift. Verdict: no unconditional cache;
only a freshness-checked, explicitly marked hint if later prioritized.

## 4. External methodology comparison

### Headroom

The Headroom README and documentation were read from its public repository/docs.
Its relevant methods are:

- content routing: JSON/log, AST-aware code, and prose use different compressors;
- live-zone compression: only new/volatile bytes are transformed while the frozen
  prefix stays byte-identical for provider KV-cache reuse;
- CCR: compressed content keeps a local original retrievable on demand;
- hash-keyed dedup/shared memory and explicit metrics;
- output shaping for model verbosity/effort, with estimated savings labeled as
  estimated and holdout traffic used for measured savings;
- fail-open behavior and local-first storage.

Headroom's published proof table reports 21% savings on a 100-result code-search
scenario, 42% on codebase exploration, and 57% on SRE incident debugging. Those
are Headroom's benchmark results, not this extension's results. Its repository
also warns that short/already-dense inputs may see little benefit.

### Manus

Manus's published context-engineering article emphasizes:

- stable prompt prefixes for KV-cache hits;
- deterministic, append-only context rather than rewriting earlier observations;
- masking tool availability instead of dynamically changing tool definitions;
- using the filesystem as restorable external context rather than irreversible
  compression;
- reciting the current plan near the end of context to combat drift;
- retaining failed actions/observations because error evidence improves recovery.

### Combined design selected here

The strongest compatible ideas are:

1. route code/prose/search output differently (implemented scopes and adaptive
   formatter);
2. keep safety/instruction-bearing evidence verbatim and make bulky results
   bounded but recoverable (explicit full mode, spillover files, `recall`);
3. preserve stable tool contracts and deterministic identity keys (current
   parameter/content dedup and stable stringify);
4. avoid lossy semantic query substitution without a held-out accuracy test;
5. expose measurements separately from content and label estimates honestly;
6. treat the filesystem/index as backing storage, not a reason to trust stale
   in-memory data.

This deliberately does **not** copy every Headroom feature: a new ML prose
compressor, cross-agent memory, semantic query cache, or proxy layer would add
large dependencies and failure modes without evidence that this repository needs
them.

## 5. Final prioritization

**Implemented:** prose scope filtering, adaptive/bounded code-search output,
pre-ranking filters, repo-map orientation, AST-bounded chunk/output behavior,
and regression coverage. The retrieval-profile benchmark recommends hybrid
when semantic ranking is enabled, but does not change the persisted lean default
without a broader corpus/accuracy study.

**Confirmed but deferred:** bounded fuzzy-read suggestions, composite/bare-symbol
navigation, first-class grep, uniform LSP metadata, directory diagnostics,
operation timing details, and a freshness-checked read-after-write hint.

**Rejected for now:** automatic Jaccard query reuse and search-as-read edit
authorization. The former risks silent false negatives; the latter weakens a
safety invariant demonstrated by the guard experiment.

The feedback files with `-done` suffix are the ones whose requested behavior is
implemented or whose issue is external/fully addressed. The remaining files are
not claims that every suggestion should be built; they document verified gaps,
known boundaries, and the evidence required before adding complexity.
