# Opinion: `ast_search` and `code_search`

**Date:** 2026-08-28
**Subject:** Deeper look at the two retrieval tools in `pi-agent-kernel`
**Method:** Re-read the 877-line `src/retrieval/ast_search.ts` and the 559-line `src/retrieval/search_index.ts` (and their dependencies in `search_bm25.ts`, `search_chunker.ts`, `search_embedder.ts`). Then exercised the live tools with a wider range of queries than my first round — exact-match, substring-match, multi-language, semantic-only, lexical-only, and **gibberish** (to test the no-match path).

This is the more focused follow-up to my general review. The two tools are the most ambitious piece of the extension — they are also the part where the engineering is *almost* excellent and the *almost* matters.

---

## TL;DR

Both tools work, and on real queries they return genuinely useful results that would be hard to get from `rg` + reading files. `ast_search` has good ranking, good multi-language support, and an honest empty-result path. `code_search` is more ambitious (BM25 + 256-dim Matryoshka + RRF) and mostly earns the complexity — but the embedder's noise floor produces **confident false positives for nonsense queries**, and the tool returns those results with the same "Found N chunks" framing as a real hit. The combination is a real problem for an LLM-driven agent that will treat the formatted response as evidence.

If I were the maintainer, I would not ship `code_search` in its current form without a minimum-similarity threshold on the vector path. Everything else is tunable; this one is a correctness issue that will burn users.

---

## What I tested and observed

### `ast_search` — what works

**1. Exact-name lookup is fast and correct.** Query `EpistemicGuard`, get one hit, with the class kind tag and the body. This is the core use case and it works.

**2. Substring lookup is good and well-ranked.** Query `search` returned 13 hits ordered by relevance: the most consumer-facing symbols first (`SearchControlModal`, `SearchProfile`, `SearchConfig`, `SearchHit`, `SearchDeps`), the implementation functions lower. The ranking comes from a six-tier scoring function (`computeSymbolRankScore`):

- Tier 0: current-file boost (–200, ensures the active file wins)
- Tier 1: match precision (exact=0, case-insensitive=5, word-boundary=15, prefix=25, test-prefix=80, generic=50)
- Tier 2: location penalty (tests=+150, examples=+60, production=0, root=+10)
- Tier 3: module-hint bonus (–30 for dotted/colon-qualified queries like `crate::state::KeyUsage` or `webshocket.WebSocketClient`)
- Tier 4: kind weight (class/struct/enum=0, interface/trait/type=1, function=2, method=3, alias=4, variable=5)
- Tier 5: path depth (×0.1)

That's a real ranking, not a token-match-and-sort. The output ordering I saw reflects these tiers in the expected way.

**3. Cross-language works.** I dropped a Python file into the workspace and `ast_search` found both the class and its methods. The `SUPPORTED_EXTENSIONS` set covers 18 languages; the `extractFileTags` path in `repomap.ts` (which `ast_search` reuses) does the actual language-specific regex extraction. The kind values are normalized to a small set (`class`, `function`, `method`, `interface`, `type`, `variable`, `constant`, `alias`, …) regardless of source language.

**4. The empty-result path is honest.** Query `NonExistentSymbolThatDoesNotExist12345` returns the message: *"No AST symbols found matching query. (Note: For string literals, error codes, or configs, use 'rg' in bash)."* This is the right framing — the tool is saying "I don't speak this query" rather than papering over the failure. The cross-reference to `rg` for non-symbols is genuinely helpful.

### `ast_search` — what doesn't work

**Issue A1: `filePattern` is a basename substring, not a path pattern.** I queried `name: "EpistemicGuard", filePattern: "safety"` and got *zero results* — even though the file is at `src/safety/epistemic_guard.ts`. Reading the code (`src/retrieval/ast_search.ts:723`):

```ts
if (query.filePattern && !entry.name.includes(query.filePattern)) continue;
```

`entry.name` is the file *basename* (`epistemic_guard.ts`), not the relative path. So `filePattern: "safety"` doesn't match. The parameter name *strongly* implies a path pattern. The help text shows examples like `'auth'`, `'.py'`, `'test'` — which all work as basename substring matches, so the examples mislead. A user typing `filePattern: "src/safety"` (perfectly natural) gets nothing.

**Fix.** Either rename the parameter to `fileNamePattern` (matches what it does), or make the matching a path substring (e.g. check `relPath.includes(filePattern)` in addition to basename). The first option is one-line and honest; the second is what users will assume is already happening.

**Issue A2: `includeBody: true` returns the first 25 lines, not the body.** The hard-coded window is `def.line + 25` (line 730). For a 145-line class like `EpistemicGuard`, that gives the agent 17% of the implementation. The model then has to issue a follow-up `read` with a `symbol` parameter to get the full body. The parameter name `includeBody` is misleading — it suggests "yes, include the body," not "include the first 25 lines."

**Fix.** Either rename the parameter to `includeSignaturePlus25Lines` (ugly but honest), or, much better, extend the window until the closing brace at column 0 (or the next top-level declaration). For TS/JS this is a 10-line change with a real payoff. The model gets the actual body, and the user's mental model matches reality.

**Issue A3: `kind` is underdocumented for non-TS languages.** The parameter help says `function | class | method | interface | type` — five kinds. In a Python codebase, none of `interface` or `type` exist; in a Rust codebase, you have `struct`, `trait`, `impl` which the tool *does* handle internally but doesn't expose in the kind enum. A user trying to find all Python methods and typing `kind: "method"` works, but typing `kind: "function"` for a Python file returns nothing because the tool correctly tagged the method as `method`. The kind enum's docstring is TS-centric.

**Fix.** Either (a) accept the language's local term (e.g. `kind: "def"` in a Python context), (b) expand the kind enum to `function | class | method | interface | type | struct | trait | enum | impl | alias | variable | constant` and document what each maps to per language, or (c) drop the kind filter for the `ast_search` tool and tell users to filter by name. Option (c) is the simplest. The filter is rarely useful — substring name match + the ranking function usually does the right thing.

### `code_search` — what works

**1. Real semantic + lexical fusion.** Query `deterministic verification by shell exit code` returned the oracle test as the top hit, then the `runOracle.finish` function, then the `OracleExecutionResult` interface. The BM25 score (matched on `deterministic`, `verification`, `exit`, `code`) and the vector score (VecCos 0.65–0.69) both contributed. The RRF combiner (k=60) is doing what it's supposed to.

**2. Natural-language queries get good results.** Query `how does the tool prevent the model from editing files it never read` — which contains *no* tokens in common with any source file — returned three relevant results: the editing-and-verification doc, the `EpistemicGuard` class, and the `UndoResult` interface. The embedder is genuinely capturing intent here. VecCos 0.59–0.64, with the document on top.

**3. Breadcrumbs and chunk context.** Every result includes a `// [File: path] > [KIND: name] (lines N-M)` header, plus the actual chunk content. An agent receiving this output can immediately locate the source and decide whether to read further.

**4. Fallback during indexing is sane.** If the workspace is currently being indexed and the embedder isn't ready, `code_search` falls back to BM25-only and reports VecCos=0. This is the right contract — better to give fast lexical results than to block on model initialization. The graceful degradation is documented in `docs/retrieval.md`.

**5. The `RANK` numbers in the response are actually useful for debugging.** When the agent gets back `RRF=0.0328 | BM25=24.61 | VecCos=0.707`, it can tell at a glance which signal is doing the work. Low VecCos with high BM25 means "this matched on words"; high VecCos with low BM25 means "this matched on meaning." That's a feature, not a bug, and it lets the agent reason about confidence.

### `code_search` — what doesn't work

**Issue B1 (critical): The vector search returns confident false positives for nonsense queries.**

Query: `zorbax flobnax quaximilian`. Three words that do not appear in any source file, any test, any doc, anywhere in the kernel codebase.

Result: 5 hits, top one with `VecCos=0.515`, all with `RRF=0.015x` and the message *"Found 5 relevant code chunk(s) for 'zorbax flobnax quaximilian'"*. A follow-up query with `xqzv ploxn corblax vrimpdax` returned 3 hits with `VecCos=0.577` at the top.

What's happening: BM25 correctly returns `[]` because none of the query tokens are in any chunk's term-frequency map. The vector search, however, embeds the gibberish into a 256-dim space, computes cosine similarity against all ~5,000 corpus vectors, and the *maximum* similarity is around 0.5–0.6. In a high-dimensional space, two random vectors have an expected cosine around 0 (by symmetry), but a *single* random vector against a fixed corpus has a maximum that drifts upward as the corpus grows. For 5,000 256-dim vectors the typical max-cosine is around 0.5; for 768-dim it's similar. The embedder doesn't know the query is meaningless; it just returns the closest match.

**Why this matters more than usual.** The format the tool returns is "Found 5 relevant code chunk(s) for '<query>':" — exactly the same as for a real query. The model receiving this output has no signal that the matches are noise. It will (a) waste context tokens reading chunks about things the user didn't ask about, (b) potentially act on the noise (e.g. suggest edits to the test README because a nonsense query "matched" it), and (c) lose trust in the tool when the user eventually notices the misfires. The empty-result path *does* exist for BM25-only no-match cases (I tested it earlier and got "No code chunks found matching…") — but the vector path bypasses that.

**Fix.** Add a minimum-cosine threshold. A reasonable starting point is 0.70 for 256-dim Matryoshka and 0.75 for 768-dim. Below the threshold, drop the vector result from the candidate set. The math: 0.5 is the random-baseline noise floor; 0.7+ is "actually similar in the embedding space." If *all* vector results fall below threshold and BM25 also returned nothing, then the tool should return the "No code chunks found matching" message. This is one of the few changes I'd call a correctness bug.

**Issue B2 (medium): The vector noise floor contaminates real queries too.**

Look at the result for `verifyEditedFile` (a pure lexical query): every hit has `VecCos=0.59–0.62` — uniformly in the noise range. The vector scores are providing *no signal at all* in this query, but they still participate in the RRF combiner. For a chunk that has BM25 rank 1 (top match) and vector rank 200 (terrible match), the RRF score is `1/(60+1) + 1/(60+200) = 0.0164 + 0.0038 = 0.0202`. For a chunk with BM25 rank 50 and vector rank 1, the score is `1/(60+50) + 1/(60+1) = 0.0091 + 0.0164 = 0.0255`. **The vector score can flip the ranking**: a chunk that the embedder thinks is "best match" but BM25 ranks at 50 can outrank a chunk that BM25 puts at rank 1 but the embedder rates at 200.

In the nonsense-query case, this is the failure mode (vector dominates). For real queries, the contribution of `vecRank=200`-style noise is small but non-zero, and it can promote marginally-relevant chunks above genuinely-relevant ones. The right fix is the same as B1 — if the top vector score is below the noise threshold, the vector component should be dropped from RRF entirely (not just from individual results).

**Issue B3 (medium): The `file_pattern` parameter on `code_search` is also a basename substring.**

The help text says *"Optional path or filename filter (e.g. 'auth', '.py', 'test')"* — but the implementation in `search_index.ts:430` is:

```ts
if (options.filePattern && !chunk.filePath.toLowerCase().includes(options.filePattern.toLowerCase())) continue;
```

This actually *is* a path substring, not a basename substring — so it works correctly for `file_pattern: "safety"`. Good. But this asymmetry with `ast_search` (which uses basename) is confusing: the two retrieval tools have *different* file-pattern semantics for parameters that are spelled almost identically. Either align them or document the difference prominently.

**Fix.** Pick one. I'd vote for "always path substring" — it's the more useful behavior, and the help text already implies it.

**Issue B4 (low): RRF k=60 is appropriate but not exposed for tuning.**

The RRF k parameter is hard-coded to 60. For a small corpus (~5,000 chunks in the kernel's own workspace), k=60 means a rank difference of 60 produces a 2× score difference, which is mild. For a 50,000-chunk corpus in a large monorepo, the same k=60 still works, but a higher k (e.g. 100) would reduce the impact of noisy low-rank results. This is a tuning knob that some power users will want.

**Fix.** Make `k` a parameter on the `code_search` tool, with a default of 60. Document the trade-off in the help text.

**Issue B5 (low): The cached vector store assumes the chunk set hasn't changed between sessions.**

`saveToDisk` writes `index.json` (chunks + file hashes) and `vectors.bin` (concatenated Float32 vectors, ordered by `vectorChunkIds`). `loadFromDisk` reads them back. If a chunk is removed and added back between save and load, the `vectorChunkIds` order may not match the `chunks` order, and the loaded vectors could be assigned to the wrong chunks. The code does check `data.version !== 1` and skips load on mismatch, but within version 1 there's no checksum linking the two files.

**Fix.** Add a SHA256 hash of the chunk set into the index metadata, and verify it matches after loading the vectors. One-line addition, real safety.

### A cross-cutting observation: the output is well-formatted but uniform

Both tools return a chunked format with the same structure regardless of how confident the match is. The `Matches: [term, term, term]` line tells the model what was matched lexically; the `VecCos=0.707` tells it the semantic similarity; but neither tool returns any "I am not confident" signal. A pure-BM25 search of "definitely not in this codebase" words returns `[]` honestly. A pure-vector search of the same returns 5 hits at 0.515.

If the two tools had a *confidence tier* in the output — e.g. `[1] [HIGH CONFIDENCE: BM25 + VecCos both above threshold]` vs `[1] [LOW CONFIDENCE: only VecCos, no BM25 match]` — the model could weigh the results appropriately. This is a small UI change that would substantially improve how the agent reasons about search results.

---

## Final thoughts

`ast_search` is, with the three fixes above, a great tool. It's the kind of "give me the function that does X" interface that every coding agent should have, and the ranking function is sophisticated enough to be useful on real-world codebases.

`code_search` is more ambitious and more fragile. The hybrid design is correct in principle and the implementation is competent, but the lack of a minimum-similarity threshold on the vector path is a real correctness bug that will surface in production as occasional "why did the agent read the test README when I asked about authentication" mysteries. With that one fix and a confidence-tier in the output, it would be a strong tool.

The kernel's retrieval layer is the part I'm most likely to be wrong about — semantic search is hard, and the failure modes I identified might be acceptable trade-offs in the author's testing. If they are, I'd still want them documented. The README says "retrieval:hybrid-256d (Hybrid Matryoshka)" and "retrieval:dense-768d (Full)" as if higher-dimensional is strictly better; for nonsense queries it's *strictly worse* (more dimensions = more random matches to compete with), and a user picking "Full" thinking they're getting higher quality is actually getting a larger noise floor.

If I were the maintainer, the punch list for retrieval would be:

1. **Add a minimum-cosine threshold to the vector path** (Issue B1). Single biggest correctness win.
2. **Suppress vector contribution to RRF when top vector score is below threshold** (Issue B2). Pairs with #1.
3. **Rename or repurpose `ast_search.filePattern` to be a path substring** (Issue A1). One-line clarity fix.
4. **Make `ast_search.includeBody` return the full body, not 25 lines** (Issue A2). Real value-add for ~10 lines of code.
5. **Add a confidence tier to the output of both tools** (cross-cutting). Helps the agent reason about uncertainty.
6. **Pick one file-pattern semantics and apply it to both tools** (Issue B3). Consistency.
7. **Expose RRF k as a tunable parameter** (Issue B4). For power users on big codebases.

The first two are correctness. The third and fourth are clarity. The fifth is kindness to the model. The sixth is hygiene. The seventh is a power-user feature. All of them are smaller than the work that's already gone into the retrieval layer, and the system will be measurably better for each.

— end of opinion —
