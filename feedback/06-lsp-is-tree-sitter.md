# 06. `lsp` has fallback/shape inconsistencies — the original claim is mixed

## Factual re-test

The current tool first tries an installed LSP client and then uses local
Tree-sitter/AST logic when the client has no answer. The implementation reads
the source file for cursor resolution, supports both `symbol` and
`path + line + character`, and has separate fallback branches for definition,
references, hover, document symbols, and diagnostics.

On the checked-in TypeScript fixture, equivalent navigation inputs now agree
for a resolvable identifier:

| Operation | Symbol input | Coordinate input |
|---|---|---|
| definition of `withConnection` | `app.ts:27:18` | `app.ts:27:18` |
| hover at declaration | generic method signature | same generic method signature |
| references from call site | declaration plus bounded snippet | same declaration plus bounded snippet |

This disproves the broad claim that coordinate definition/hover are always
broken. The coordinate path is functional when the cursor is on the identifier
or call expression.

The remaining problems are real:

- The implementation still emits the label `Tree-sitter AST Fallback` for some
  local results. That is an implementation label, not evidence of a real
  type-aware language server.
- Output formats are not fully uniform: definitions are location-only,
  references include snippets, and hover uses markdown/code-block output.
- Directory diagnostics still fail before dispatch with `EISDIR`; the tool is
  file-oriented and does not enumerate a directory.
- A cursor on whitespace, the wrong token, or an ambiguous bare symbol can
  legitimately return no result or multiple candidates.

## Workflow comparison

**Current coordinate workflow:** identify a meaningful cursor position, then ask
for definition/hover/references. It works on the fixture and avoids a separate
symbol-discovery call when the file and location are already known.

**Current bare-symbol workflow:** pass `symbol`, which performs workspace AST
resolution and can return a richer fallback result. This is convenient but can
be ambiguous without a file or cursor.

**Proposed workflow:** standardize every response and allow directory
aggregation. That improves interpretation and diagnostics coverage, but it does
not change retrieval correctness for the tested file-level cases.

## Verdict

**Partially resolved, not a blanket bug.** Keep the working coordinate path and
rich reference snippets. The evidence supports three narrow fixes: use an
explicit `Tree-sitter AST`/`local fallback` label, standardize metadata headers,
and either enumerate source files for directory diagnostics or return a clear
"diagnostics requires a file" error. Do not claim that a real type-aware LSP is
present unless the installed client is actually used.

This follows Headroom's content-routing principle: make provenance visible and
preserve exact backing content; do not present a fallback as richer than it is.
