# Editing and Verification

The edit tool is registered by `src/tools/edit_tool.ts` and delegates patching
to `src/editing/patch.ts`.

## Edit flow

1. Resolve the target path.
2. Apply one search/replace block or multiple disjoint blocks.
3. Enforce the read-before-write guard for existing files when enabled.
4. Validate the complete candidate content with the bounded local syntax gate; the target is written only after validation succeeds.
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

## Repository history

The extension does not automatically stage, commit, reset, or otherwise alter
a repository. Edits only modify the requested file after the
candidate passes the local syntax gate.

The edit result reports verification in `details`, while the visible message
remains compact. Failed candidate validation leaves the target unchanged and
reports the failure. Post-write diagnostic failures do not roll back an
already-valid edit; their uncertainty remains explicit.
