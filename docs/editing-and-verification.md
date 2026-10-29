# Editing and Verification

The edit tool is registered by `src/tools/edit_tool.ts` and delegates patching
to `src/editing/patch.ts`.

## Edit flow

1. Resolve the target path.
2. Apply one search/replace block or multiple disjoint blocks.
3. Enforce the read-before-write guard for existing files when enabled. Successful edits update the epistemic ledger to maintain continuity across sequential edits without redundant reads.
4. Check the syntax of the complete candidate content (see below). With the default `editing.syntax_gate = "warn"`, a candidate that fails is still written and the failure is reported; with `"block"`, the target is left unchanged.
5. Return compact status text and structured verification details.

The patch engine tries exact and normalized matching strategies and refuses an
ambiguous or missing match rather than guessing.

## Syntax check

Each edit is checked once, before writing, on a copy in the system temp folder.

- TypeScript, TSX, and JSX: tree-sitter clears the edit when it finds no error
  in the new content or in the original; anything else is decided by `tsc`
  (parse only). The tree-sitter grammar lags the language, so its errors alone
  never fail an edit.
- JavaScript: `node --check`, as an ES module and as CommonJS; the content is
  valid when either parses.
- Python: `py_compile`. JSON: `JSON.parse`.
- Rust, Go, C, C++, Java, C#, Ruby, PHP, and Bash: tree-sitter. Errors are
  reported only when the original file parsed without errors; otherwise the
  check is `not run`.
- Other files: `not run`.

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
a repository. Edits only modify the requested file.

The edit result reports verification in `details`, while the visible message
remains compact. With `syntax_gate = "block"`, failed candidate validation
leaves the target unchanged and reports the failure. Post-write diagnostic failures do not roll back an
already-valid edit; their uncertainty remains explicit.
