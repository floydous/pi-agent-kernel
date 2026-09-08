# 08. Edit guard is content-aware and intentionally rejects search evidence

## Factual re-test

The guard was exercised against a 40-line temporary file:

| Evidence before edit | Target | Result |
|---|---|---|
| `ast_search`-style search evidence for lines 20–25 | 20–25 | blocked: read required |
| read lines 1–5 | 20–25 | blocked: target lines not covered |
| read lines 20–25 | 20–25 | allowed |
| external append after the read | 20–25 | blocked: file changed since read |

The integration also records `ast_search` and `code_search` results as
`kind: "search"`, while native reads record `kind: "read"`. The edit precondition
requires read evidence and a matching current fingerprint.

Thus the old “path-only/content-blind” description is no longer true. The guard
tracks ranges and a content fingerprint. It intentionally treats search evidence
as weaker evidence that never authorizes a mutation; seeing a declaration or a
ranked hit is not the same as inspecting the exact edit context.

## Workflow comparison

**Current safe workflow:** search or locate a symbol → read the target range →
edit. A first edit on a new file costs one read, and later edits can reuse the
fresh fingerprint/ranges until the file changes.

**Suggested search-as-read workflow:** search → edit. The experiment shows that
this is blocked, and that is desirable: search metadata can omit surrounding
lines, stale content, or the exact replacement occurrence.

**Potential compromise:** an explicit auditable override could acknowledge that
risk, but it should not silently weaken the default guard.

## Verdict

**Resolved as a correctness issue; the remaining behavior is intentional safety.**
Do not make search results silently satisfy the guard. A narrowly scoped future
improvement could include the matched target range in the rejection message or
allow an explicit, auditable override for an exceptional edit.
