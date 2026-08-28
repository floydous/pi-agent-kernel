# Editing and Verification

The edit tool is registered by `src/tools/edit_tool.ts` and delegates patching
to `src/editing/patch.ts`.

## Edit flow

1. Resolve the target path.
2. Apply one search/replace block or multiple disjoint blocks.
3. Enforce the read-before-write guard for existing files when enabled.
4. Run bounded local syntax verification.
5. Reuse an already-ready LSP client when one exists; verification does not
   start a new language server or trigger broad analysis.
6. Return compact status text and structured verification details.

The patch engine tries exact and normalized matching strategies and refuses an
ambiguous or missing match rather than guessing.

## Verification states

The renderer keeps uncertainty explicit:

- `clean` — the check completed without findings.
- `failed` — the check completed and found a failure.
- `findings` — diagnostics were returned.
- `not run` — no check was requested or available.
- `unavailable`, `timeout`, and `inconclusive` — verification did not establish
  a reliable result.

These states must not be collapsed into `clean`.

## Git behavior

The existing edit path retains its current automatic commit behavior after a
clean local syntax gate. `autoCommitFile()` and `undoLastCommit()` are separate
helpers in `src/editing/git-verify.ts`; changing commit policy is intentionally
separate from the source-layout migration.

The edit result reports verification and commit information in `details`,
while the visible message remains compact. Failed verification preserves the
edit and reports the failure instead of silently rolling it back.
