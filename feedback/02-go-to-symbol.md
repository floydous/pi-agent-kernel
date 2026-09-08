# 02. No fast "go to" by bare symbol name — real, but low impact

## Factual re-test

The current tools do cover the workflow, but not in one call. On the checked-in
polyglot fixture, resolving `withConnection` required:

1. `ast_search({ name: "withConnection", kind: "method" })`
2. `read({ path: "tests/fixtures/polyglot/src/app.ts", symbol: "withConnection" })`

The measured outputs were 110 and 354 characters respectively (464 characters
combined). A hypothetical composite goto would return the same information in
one call, but it would not reduce the payload: approximately 464 characters
still have to reach the model if both the declaration and body are needed.

The typo workflow is also real. `read({ symbol: "withConnectio" })` fails, then
`ast_search({ name: "withConnectio" })` finds `src/app.ts:27:withConnection`,
then a second read is needed. The current failure is about discoverability, not
missing search capability.

## Session evidence

The original Gateway session recorded only one `ast_search → read` sequence
(652 characters) and three `ast_search → lsp` sequences (3,473 characters).
Repeated `ast_search` refinement was much more common. A composite navigation
primitive is therefore a convenience improvement, not a major token-saving
innovation.

## Verdict

**Issue confirmed, priority low.** Add a `goto`/`describe` operation only if
single-call navigation is a product goal. It should return a bounded declaration
and location first, with body/references opt-in; bundling everything by default
would increase output rather than improve efficiency.

This matches Headroom's content-aware approach: compress or defer bulky backing
content, but keep the small actionable location/signature inline and make full
content retrievable on demand.
