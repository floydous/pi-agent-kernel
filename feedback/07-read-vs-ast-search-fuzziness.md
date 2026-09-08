# 07. `read` exact symbols versus fuzzy `ast_search` — real, tiny friction

## Factual re-test

`read({ symbol })` performs exact AST extraction. A typo such as
`withConnectio` returns an error. `ast_search({ name: "withConnectio" })`
performs substring discovery and finds `withConnection` at `src/app.ts:27`.
The resulting workflow needs the discovery call and then a second exact symbol
read. The failure message is short (about 100 characters); the main cost is one
extra search/read round trip.

This is not the same as saying `read` is wrong. Silent fuzzy extraction could
select the wrong function when names share a prefix. Exact failure is the safe
behavior at a mutation-adjacent boundary.

## Workflow comparison

**Current:** failed exact read → `ast_search` discovery → exact `read`.

**Suggested:** failed exact read → tool-generated bounded candidate list → exact
`read` chosen by the agent. The second workflow removes one discovery call but
must still require explicit selection of the candidate.

## Verdict

**Issue confirmed, low impact.** A safe improvement is to add bounded
`Did you mean?` suggestions to the exact-symbol error, using the existing AST
index, without silently extracting a fuzzy match. Automatic extraction would be
unsafe when multiple symbols share a prefix.

This is a good fit for reversible context design: return a compact candidate
list inline and leave exact body retrieval explicit.
