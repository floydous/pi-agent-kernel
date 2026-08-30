# Feedback Fix Goal

## Purpose

Track every reported feedback issue and work through them one at a time. This file is a checklist and evidence log, not a claim that all issues are fixed.

## Operating rules

- Preserve the project philosophy: **minimum token usage, maximum performance**.
- Reproduce the reported behavior before changing code.
- Do not treat a passing focused test as proof that the entire feedback item is resolved.
- Do not guess. Record `unknown`, `not reproduced`, `partial`, or `blocked` when evidence is incomplete.
- For each confirmed defect: add a focused regression reproduction, make the narrowest change, and rerun the focused check.
- Read the relevant file immediately before editing it.
- Do not run broad scanners, embeddings, repository-wide analysis, or the full suite after every edit. Run the full suite only at an appropriate final checkpoint.
- Do not spawn a language server solely for post-edit verification; reuse only an already-ready client.
- Do not report unavailable, timed-out, unsupported, or inconclusive checks as clean.
- Keep the edit tool’s normal output compact; merge labels with identical values.
- Preserve API signatures and read-before-write behavior unless a deliberate change is approved.
- Do not use standalone scripts to rewrite repository code or imports; code edits must use the actual edit tool.
- Keep `src/ui/tui_utils.ts` untouched unless it is independently justified.
- Do not restore deleted tracked artifacts, remove `_feedback/`, or remove cache artifacts until their intended status is determined.
- Do not commit or push until the final diff, verification state, retained-file intent, and remote state are reviewed.

## Status vocabulary

- `OPEN`: reported issue has not been fixed.
- `PARTIAL`: some behavior is improved, but the reported concern remains or is not fully verified.
- `FIXED`: reproduction fails to demonstrate the old defect and a focused regression check passes.
- `NOT REPRODUCED`: the current checkout does not reproduce the report; this is not the same as fixed.
- `UNKNOWN`: evidence is insufficient.
- `BLOCKED`: requires a product/design decision or unresolved worktree/file ownership decision.

## Current baseline

- Repository: `C:\Users\brat\.pi\agent\extensions\agent-kernel`
- Branch: `master`
- HEAD at the start of this tracking file: `f1ddde4 docs: record feedback reproduction verification`
- Feedback claimed a 30-section suite; the repository contains 28 `tests/section-*.ts` files and the runner imports all 28. Historical `test.ts` is only a compatibility shim, and repository history contains no additional section files. The feedback’s 30-section count is not reproducible from this checkout; the two-section discrepancy is recorded as `NOT REPRODUCED`, not as a missing implementation.
- The worktree was cleaned for the push: ambiguous/unrelated changes remain preserved in `stash@{0}`, `_feedback/` remains excluded, and the branch is synchronized with `origin/master`.
- No source implementation change was made by creating or updating this tracking file.

## Issue matrix

### Feedback 1 — Epistemic guard semantics

- **Status:** `PARTIAL / OPEN`
- **Reported behavior:** A file named in a command can become eligible even when the command did not expose its contents to the model. The guard’s name and error text imply stronger epistemic grounding.
- **Verified current evidence:** `ls`, `stat`, `wc -l`, `grep -c`, `grep -q`, and `rg -l` produce no inspected-file evidence. `cat`, `grep -n`, and `rg -n` are classified as content inspection by command shape. The guard remains preflight/shape based and cannot prove that output was displayed or understood.
- **Required decision:** Compare and measure a stricter result-aware/native-reader design against the current behavior before selecting one. Consider whether the correct outcome is stronger enforcement or an honest rename/documentation change.
- **Completion evidence:** Actual tool-boundary reproduction, same-batch behavior, focused regression tests, and explicit documentation of what the guard proves.

### Feedback 2 — Failed verification leaves broken content on disk

- **Status:** `FIXED`
- **Reported behavior:** A patch could be written before syntax verification, leaving invalid source on disk.
- **Verified current evidence:** An invalid replacement (`const x = (1;`) through the registered `edit` tool returned an error and left the file byte-for-byte unchanged. The candidate error reported an unclosed `(`.
- **Completion evidence already present:** Direct reproduction and focused sections 5, 6, and 25 pass.
- **Remaining action:** Preserve as closed unless a later change regresses it.

### Feedback 3 — Literal `[EMAIL]` Git identity

- **Status:** `FIXED for placeholder; OPEN as policy question`
- **Reported behavior:** Auto-commits could use a literal placeholder identity.
- **Verified current evidence:** Fresh-repository auto-commit produced `Pi Agent <pi@agent.local>`, not `[EMAIL]`.
- **Remaining question:** Whether auto-commit should honor repository-configured `user.name` and `user.email` instead of using the deterministic fallback. Do not change this without deciding the identity policy and testing configured, absent, and first-commit cases.

### Feedback 4 — First-commit failure visibility

- **Status:** `NOT REPRODUCED / OPEN FOR CONTRACT REVIEW`
- **Reported behavior:** First-commit failure could be silent and leave the edit only in the working tree.
- **Verified current evidence:** A fresh Git repository with no prior commit successfully auto-committed and returned `{ state: "committed" }` using `Pi Agent <pi@agent.local>`.
- **Remaining question:** Independently of the successful path, define the result contract for a genuine commit failure. The user-facing edit result must distinguish committed, working-tree-only, and failed states.
- **Completion evidence:** Inject or reproduce a real commit failure and verify the visible result and `/undo` behavior without claiming a failed or unavailable scenario is clean.

### Feedback 5 — Global `__default__` session ID

- **Status:** `FIXED / VERIFY REGRESSION`
- **Reported behavior:** Contexts without a host session ID shared `__default__` guard state.
- **Verified current evidence:** Two fallback contexts were exercised through the registered tools. A file read and edited in context A was allowed; an edit from context B without a read was rejected.
- **Completion evidence already present:** Per-session guard result was `8 passed, 0 failed`; direct tool-boundary isolation reproduction passed.
- **Remaining action:** Keep closed unless session lifecycle changes affect the fallback path.

### Feedback 6 — README “6-tier instruction precedence” claim

- **Status:** `FIXED`
- **Reported behavior:** README claimed an unimplemented six-tier precedence system.
- **Verified current evidence:** The claim was removed; lifecycle testing confirmed custom system prompt preservation and no duplicated hardcoded precedence text.
- **Completion evidence already present:** Section 24 lifecycle checks pass.

### Feedback 7 — Foreground embedding/model loading

- **Status:** `PARTIAL / UNKNOWN`
- **Reported behavior:** Switching from lean to a semantic profile could block the foreground/TUI while the model loads.
- **Verified current evidence:** Profile-triggered indexing uses `void runSync()` and the existing background lifecycle. The first semantic search can still lazily initialize embeddings if vectors are not ready. No interactive latency benchmark was captured.
- **Required decision:** Measure profile-switch return time, first semantic-search behavior, and TUI responsiveness. Compare background preload, explicit “not ready” fallback, and lazy foreground initialization before changing architecture.
- **Completion evidence:** Reproducible timing and UI-boundary results, not an assumption based on source inspection.

### Feedback 8 — Patch `success` does not imply syntax validity

- **Status:** `PARTIAL / DOCUMENTED`
- **Reported behavior:** `applySurgicalPatch` success means matching/replacement succeeded, not that the resulting source is valid; the contract was implicit.
- **Verified current evidence:** The edit path now validates the candidate before writing, and invalid edits are rejected atomically. The lower-level patch result still represents patch composition rather than syntax validity.
- **Required action:** Ensure the `PatchResult` contract clearly states this distinction and that future callers cannot mistake patch success for syntax validity.
- **Completion evidence:** Contract documentation plus focused tests for both patch composition and syntax rejection.

### Feedback 9 — `src/index.ts` is too large

- **Status:** `OPEN / DEFERRED`
- **Reported behavior:** One large extension function owns tool registration, commands, indexing, interceptors, lifecycle, and footer concerns.
- **Verified current evidence:** `src/index.ts` remains large and contains these concerns.
- **Required decision:** Measure whether extraction improves reviewability without harming startup, lifecycle behavior, or token/performance goals. Do not refactor without a bounded plan and regression coverage.
- **Potential scope:** Extract background indexing, command handlers, and tool interceptors incrementally, preserving public APIs and behavior.

### Feedback 10 — `agent-kernel` vs `pi-agent-kernel` naming

- **Status:** `OPEN / DEFERRED`
- **Reported behavior:** Directory, package name, README, and terminology are inconsistent.
- **Verified current evidence:** The naming mismatch exists.
- **Required decision:** Select one canonical name only after checking package metadata, documentation, import paths, and publishing/extension conventions. Do not perform a repository-wide rename speculatively.

### Retrieval A1 — `ast_search.filePattern` path semantics

- **Status:** `FIXED`
- **Reported behavior:** A natural path fragment such as `src/safety` did not match because only the basename was checked.
- **Verified current evidence:** A temporary `src/safety/sample.py` queried with `filePattern: "src/safety"` returned `src/safety/sample.py`.
- **Completion evidence already present:** Focused aliased re-export/path-filter checks pass.

### Retrieval A2 — `ast_search.includeBody` truncation

- **Status:** `PARTIAL / OPEN`
- **Reported behavior:** `includeBody: true` returned only the first 25 lines for a larger symbol.
- **Verified current evidence:** The bounded preview remains and reports `bodyTruncated: true`; the tool directs callers to `read_symbol` for the complete body.
- **Required decision:** Experimentally compare full-body output with bounded preview plus explicit follow-up, measuring token cost, latency, and usefulness. Do not assume full bodies are preferable under the minimum-token requirement.

### Retrieval A3 — AST kind documentation

- **Status:** `FIXED / VERIFY REGRESSION`
- **Reported behavior:** The tool documentation exposed too few language-normalized kinds.
- **Verified current evidence:** Python `method` and standalone `function` lookups work, and the supported kinds were expanded/documented.
- **Completion evidence already present:** Cross-language focused checks pass.

### Retrieval B1 — Vector false positives for gibberish

- **Status:** `FIXED for verified threshold behavior`
- **Reported behavior:** Nonsense queries received semantic hits with no lexical support.
- **Verified current evidence:** Controlled hybrid search with no BM25 results and orthogonal query/corpus vectors returned zero results. The current profile threshold is `0.6`, and low-confidence vectors are filtered before RRF.
- **Known limitation:** The threshold has not been calibrated against a larger labeled corpus. Do not call that calibration complete.

### Retrieval B2 — Low-quality vectors contaminate RRF

- **Status:** `FIXED for thresholded vector path`
- **Reported behavior:** Low-similarity semantic candidates could influence hybrid ranking.
- **Verified current evidence:** The controlled orthogonal-vector search returned zero candidates, demonstrating that below-threshold vectors do not enter the result set/RRF path.
- **Known limitation:** Broader threshold calibration remains open.

### Retrieval B3 — `code_search.file_pattern` and `ast_search.filePattern` inconsistency

- **Status:** `PARTIAL / OPEN`
- **Reported behavior:** Similar parameters had different semantics.
- **Verified current evidence:** `code_search` uses a relative path substring; `ast_search` was changed to normalized relative-path matching. The effective behavior is now aligned for path fragments, but the public documentation and casing/glob expectations still need review.
- **Completion evidence:** Cross-tool tests covering directory fragments, filenames, separators, and negative matches.

### Retrieval B4 — Hard-coded RRF `k`

- **Status:** `FIXED`
- **Reported behavior:** RRF `k` was not exposed for tuning.
- **Verified current evidence:** `code_search` accepts `rrf_k` and passes it to the index search options.
- **Completion evidence already present:** Focused retrieval checks pass.

### Retrieval B5 — Vector cache/chunk mismatch

- **Status:** `FIXED for corruption/hash validation`
- **Reported behavior:** Vector data could be associated with the wrong chunk set/order across sessions.
- **Verified current evidence:** Cache metadata/hash validation exists. Corrupting `vectors.bin` resulted in `loadedVectorCount: 0` while the chunk index remained available.
- **Known limitation:** No larger compatibility/migration matrix has been established; preserve the current versioning behavior.

### Retrieval cross-cutting — Confidence tiers

- **Status:** `OPEN / DEFERRED`
- **Reported behavior:** Lexical-only, semantic-only, hybrid, and low-confidence results were presented too uniformly.
- **Verified current evidence:** Results expose signal labels and scores (`lexical`, `semantic`, `hybrid`) but no explicit confidence tier.
- **Required decision:** Compare compact labels versus tiered output for token cost, width safety, and model usefulness. Preserve custom rendered-line width limits.

## Verification inventory

Already verified in the current pass:

- Invalid edit is rejected before disk mutation.
- Shell command-shape filtering for metadata-only and non-content modes.
- Hybrid vector abstention fixture.
- AST path filtering, aliased re-export lookup, dotted lookup, multiline signatures, and bounded-body metadata.
- Per-session guard: 8 passed, 0 failed.
- Fresh-repository auto-commit with deterministic fallback identity.
- Targeted TypeScript compilation: exit code 0.
- Restricted cached diagnostics: no error issues for diagnosed implementation/test files; this was not a fresh full scan.
- `git diff --check`: no whitespace errors; line-ending conversion warnings remain.
- Current complete runner: 28 passed, 0 failed.

## Work order

Work on exactly one open or partial item at a time:

1. Resolve the 30-versus-28 section inventory discrepancy.
2. Resolve the epistemic guard semantics (reproduce at the actual tool boundary, then choose stricter evidence or honest naming/documentation).
3. Resolve the commit result contract for genuine failures and decide Git identity policy.
4. Measure and resolve embedding lifecycle responsiveness.
5. Decide the AST body contract using measured token/performance results.
6. Clarify the patch result contract if still needed after reviewing its documentation.
7. Align and test retrieval file-pattern semantics.
8. Decide whether confidence tiers improve retrieval output without violating width/token constraints.
9. Consider `src/index.ts` extraction only after behavior is covered.
10. Resolve package/project naming consistency.

For each item, record:

```text
Status:
Reproduction command and exact result:
Files read:
Files changed:
Focused verification:
Remaining limitation or decision:
```

## Worktree and release gate

Do not clean up or commit the following until ownership/intent is established:

- tracked deletions: `diag.mts`, two `docs/feedback-*.md` files, `src/__test_uninspected.ts`, `tests/lang_probe.py`;
- untracked `_feedback/` files;
- untracked `tests/__pycache__/lang_probe.cpython-311.pyc`;
- unrelated or not-yet-classified changes, especially `src/ui/tui_utils.ts`;
- existing changes across the test runner and many test sections.

Before any commit or push:

1. Review the complete diff by ownership category.
2. Confirm retained-file intent for deletions and untracked files.
3. Re-run the complete reproduction matrix.
4. Run the appropriate final verification layers once.
5. Check remote synchronization separately.
6. Report unresolved, unverified, unavailable, or deferred items explicitly.
