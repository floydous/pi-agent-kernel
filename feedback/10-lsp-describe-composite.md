# 10. Composite `lsp describe` — useful convenience, not a demonstrated bottleneck

## Factual re-test

For `withConnection`, the current workflow is:

1. `ast_search` to discover the declaration;
2. `read(symbol)` to inspect the body;
3. optionally `lsp references` or `lsp hover` for callers/type information.

The measured declaration-plus-body path was two calls and 464 characters. A
one-call composite can remove a round trip, but if it includes the same body,
location, signature, and references it does not reduce the payload. If it
includes all of them by default, it can make the result larger than the targeted
workflow.

The original Gateway log had four definition, four reference, and three hover
calls, so a composite could have removed some navigation calls. That is a
quality-of-life saving, not evidence for a broad compression feature.

## Workflow comparison

**Current:** choose the next precise primitive based on what is missing. This
keeps output small but requires the agent to orchestrate related calls.

**Naive composite:** always return definition, hover, references, and body. This
reduces round trips but over-fetches information for most lookups.

**Best combined design:** one bounded `describe` call returns location,
signature, reference count, and optionally a short body preview. Full body or
full references remain explicit/retrievable. That is the same “compact digest
plus restorable backing detail” trade-off used by CCR.

## Verdict

**Issue confirmed as optional ergonomics, not a high-impact token problem.** If
implemented, make `describe` bounded and opt-in; do not bundle all correlated
content by default.
