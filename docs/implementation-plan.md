# Pi Agent Kernel Feedback Implementation Plan

**Status:** Initial implementation pass complete; final focused verification pending.
**Repository:** `pi-agent-kernel`
**Authoritative plan:** This file is the implementation and verification record for
the feedback reviewed in `_feedback/`.

## 1. Objective

Address the verified feedback findings in a way that preserves the project's core
priorities:

1. Minimum token usage.
2. Maximum practical performance.
3. Maximum reliability and explicit failure handling.
4. Read-before-write safety.
5. Existing public API compatibility unless a deliberate, tested change is
   approved.

No behavior will be selected from instinct, an unmeasured hypothesis, or a
feedback recommendation alone. Each behavior-changing candidate must first be
exercised against a controlled fixture and compared with the current behavior.

## 2. Scope

This plan covers:

- shell evidence semantics for the read-before-write guard;
- semantic-search abstention and RRF behavior;
- AST search body and kind contracts;
- session fallback isolation;
- patch and commit-result contracts;
- embedding-load workflow behavior;
- focused documentation and regression coverage;
- optional maintainability work only if measurements or an explicit request
  justify it.

The following changes already belong to the completed selected scope and must not
be reimplemented or regressed:

- metadata-only shell commands no longer count as content inspection;
- candidate single- and multi-block patches are syntax-validated before target
  writes;
- invalid candidates preserve the original target bytes;
- AST path filtering uses normalized relative paths;
- custom edit verification is not duplicated by the result interceptor;
- detailed commit states are available without removing the boolean helper;
- vector-cache metadata, mapping, dimension, byte-length, and hash checks exist;
- BM25 remains usable when vector data is invalid;
- unsupported six-tier precedence documentation was removed;
- verification output remains compact and grouped;
- the protected `src/ui/tui_utils.ts` change remains untouched.

## 3. Constraints and invariants

- Do not guess thresholds, identifiers, APIs, or platform behavior.
- Read an existing file immediately before editing it, then use the actual edit
  tool for repository changes.
- Do not use standalone scripts to rewrite repository source or imports.
- Do not automatically run the full suite, broad scanners, embeddings, or
  repository-wide analysis after each edit.
- Use focused experiments during development and run the complete suite only at
  the final verification checkpoint.
- Do not spawn a language server solely for post-edit verification. Reuse only an
  already-ready client.
- Never report unavailable, timed-out, unsupported, failed, or inconclusive
  verification as clean.
- Preserve compact edit output and merge labels with identical values.
- Preserve the terminal-width invariant for custom rendered lines.
- Do not treat `/oracle` as safe for untrusted input. It remains an explicitly
  user-invoked shell escape hatch.
- Do not restore, delete, or otherwise reconcile unresolved tracked deletions,
  `_feedback/`, generated artifacts, or unrelated existing modifications without
  separately determining their intended status.
- Do not commit or push until the final diff, verification state, and retained-file
  intent are reviewed.

## 4. Verified current behavior

The following facts were reproduced against the current source:

### 4.1 Guard evidence

`ls`, `stat`, and `wc` do not record an existing file. Known content-reader
command shapes such as `cat`, `head`, `tail`, `sed`, `awk`, `grep`, `rg`, `less`,
and `more` do record an existing file during `tool_call` preflight.

A command such as `grep -c absent file.ts` also records the file even though its
result may only be `0`. The current guard therefore records classified
command-shape evidence; it cannot prove shell output or model comprehension at
preflight time.

The same-batch shell-read plus edit workflow currently depends on preflight
recording because shell result output is not available when the sibling edit
checks its guard.

### 4.2 Atomic patching

The current patch functions compose the complete candidate in memory, validate it
through a temporary sibling file using `checkSyntaxContent()`, and write the
original target only after candidate syntax validation succeeds. Focused tests
confirmed byte preservation for invalid single- and multi-block candidates.

This protects the target from the validated syntax failures in scope. It does not
claim full type correctness, semantic correctness, or guaranteed safety against a
concurrent external rewrite between validation and write.

### 4.3 Commit behavior

The current detailed commit helper reports `committed`, `not_git_repo`, `failed`,
and `nothing_to_commit`. A new repository can receive its first commit using the
current deterministic identity `Pi Agent <pi@agent.local>`. The literal `[EMAIL]`
placeholder reported in the feedback is absent.

The remaining question is policy: whether to retain the deterministic identity or
use configured Git identity with an explicit fallback.

### 4.4 AST search

`ast_search.filePattern` now matches normalized relative path fragments, including
`src/safety`, `safety`, filenames, extensions, and normalized separators.

`includeBody` remains intentionally bounded to an approximately 25-line preview.
It does not return a complete large symbol body.

The implementation recognizes more kinds than the short public description lists,
including `struct`, `trait`, `enum`, `alias`, `variable`, and `constant` where
available from the parser.

### 4.5 Hybrid search

Vector candidates are now filtered before RRF using an initial `0.6` cosine floor
for hybrid and full profiles. A bounded feedback fixture showed positive-query
scores from approximately `0.687` to `0.746` and negative-query scores from
approximately `0.446` to `0.555`; vector-only candidates below the floor were
excluded. This is an initial operational boundary, not a final corpus-calibrated
threshold, so larger labeled-corpus calibration remains planned.

### 4.6 Session and performance behavior

The integration now assigns a process- and context-unique fallback session ID when
the host does not provide one. Hybrid/full embedding initialization is still
awaited in the foreground indexing path. `src/index.ts` remains a large
integration module.

## 5. Decision gates

A candidate may be retained only when all applicable gates pass.

### Safety

- Invalid syntax candidates leave the target byte-for-byte unchanged.
- Clearly metadata-only evidence cannot satisfy the selected guard contract.
- Sub-threshold vectors cannot silently create ordinary-looking search evidence.
- Cache corruption cannot silently associate a vector with another chunk.

### Workflow

- Common native read, search, shell-read, and edit workflows remain predictable.
- Same-batch behavior is documented and tested.
- Recovery does not require unnecessary tool calls or broad reinspection.

### Reliability

- Failure, timeout, unavailable, unsupported, and inconclusive outcomes remain
  explicit.
- A valid edit is not presented as committed when Git commit failed.
- LSP availability is not inferred from a client that was never ready.

### Performance

- Added output stays bounded.
- Added latency and memory cost are measured.
- Vector filtering does not require expensive extra model calls.
- Lean mode remains zero-embedding and fast.

### Compatibility

- Existing exported helpers and compatibility paths remain available where
  possible.
- Parameter changes are additive or deliberately versioned.
- Existing CRLF, UTF-8, and multi-block behavior remains covered.

### Documentation

- Names, descriptions, and status labels match actual behavior.
- Deferred work is identified as deferred, not reported as implemented.
- No section heading is followed by redundant epistemic labels.

## 6. Phase 0 — Preserve and classify the worktree

### Actions

1. Capture `git status --short --untracked-files=all` and the complete diff name
   status.
2. Classify every change as selected implementation, focused test/documentation
   support, protected unrelated change, deleted artifact, generated artifact, or
   unresolved.
3. Leave unresolved deletions, `_feedback/`, `tests/__pycache__/`, and the
   protected TUI modification untouched until their intent is determined.
4. Do not commit or push during classification.

### Exit criteria

- A retained-file list exists.
- No file has been restored or deleted solely from assumption.
- The implementation and verification diffs can be reviewed independently from
  unrelated worktree state.

## 7. Phase 1 — Decide the guard contract

The guard cannot prove that a model understood a file. The decision must choose
between a stronger observable-content policy and an honest weaker name/contract.

### Candidates

#### A0 — Current classified command-shape evidence

Control group. Keep native reads, search results, and known shell content-reader
shapes as evidence. Continue rejecting metadata-only commands. Preserve same-batch
preflight compatibility.

#### A1 — Stricter shell command policy

Permit only commands whose normal operation emits file content, with explicit
handling for options and redirections. Search commands that can return only counts
or status would not automatically satisfy the guard.

#### A2 — Result-aware shell evidence

Record shell evidence only after a successful result containing content. Measure
this separately because it changes same-batch `cat` plus edit behavior.

#### A3 — Native-tool-only evidence

Only `read`, targeted symbol reads, AST search, and code search satisfy the guard.
Shell commands never satisfy it.

#### A4 — Rename and document the current contract

Retain A0 behavior but rename the concept to a reference/content-reader evidence
guard, if that is the measured compatibility winner. Documentation must state that
it does not prove output exposure or comprehension.

### Experiment matrix

Run each candidate with the same temporary existing file and session fixture:

- native `read` then edit;
- targeted symbol read then edit;
- AST search then edit;
- code search then edit;
- `cat`, `head`, `tail`, `sed`, `awk`, `grep`, and `rg` then edit;
- `grep -c` with zero output then edit;
- `wc`, `ls`, `stat`, `file`, and `find` then edit;
- same-batch `cat` plus edit;
- search result for an unrelated symbol then edit;
- new-file write;
- another-session inspection then edit;
- Windows case variants and POSIX case-sensitive behavior.

Record allowed/rejected state, reason, output bytes, tool-call count, elapsed time,
and whether the observation is definitive or preflight-only.

### Exit criteria

Select the smallest policy that rejects clearly non-content evidence, preserves
needed workflows, and accurately states what is and is not proven. Add focused
regressions for every retained boundary.

## 8. Phase 2 — Make the patch contract explicit

The runtime atomic candidate behavior is already implemented. This phase makes its
contract explicit and checks race/validator boundaries without broadening scope.

### Actions

1. Add a doc comment to `PatchResult` stating that `success: true` means the
   candidate was located, composed, syntax-validated, and written; it does not
   mean type or semantic validation passed.
2. Verify that single- and multi-block paths continue to validate the complete
   candidate before writing.
3. Test supported candidate validators for TypeScript/JavaScript, JSON, and
   Python using focused fixtures.
4. Record the limitation that an external change after the initial read may still
   race the final write. Do not add locking or compare-and-swap behavior without
   a separate measured requirement.

### Exit criteria

- Contract documentation matches the call order.
- Invalid candidates preserve bytes and temporary validation artifacts are cleaned.
- No unrelated patch strategy or line-ending behavior changes.

## 9. Phase 3 — Choose vector abstention and RRF behavior

This phase is required before adopting any numeric threshold.

### Corpus

Create a bounded, labeled fixture containing:

- exact symbol queries;
- exact error/message queries;
- known conceptual queries;
- cross-language queries;
- documentation-only and source-only queries;
- random gibberish;
- plausible absent identifiers;
- valid concepts with no implementation;
- terms that occur only in unrelated files.

### Measurements

For each configured vector profile, record:

- BM25 result count;
- top and top-five cosine scores;
- RRF ordering;
- relevant and false-positive counts;
- query latency;
- output bytes and lines;
- whether the model was loaded or fallback was used.

### Candidates

#### D0 — Current unrestricted vector contribution

Control group.

#### D1 — Candidate score threshold

Measure a range of thresholds; values such as `0.70` and `0.75` are experimental
inputs only, not predetermined answers. Use separate measurements for 256 and
768 dimensions if their distributions differ.

#### D2 — Query-level abstention

If the best vector score is below the measured boundary, remove the vector signal
for the query rather than merely hiding individual scores.

#### D3 — Thresholded candidate filtering

Keep only above-boundary vector candidates before RRF. Confirm that a low-scoring
candidate cannot influence the combined ordering.

#### D4 — Compact evidence tier

If useful after D1–D3, expose one bounded signal label: `lexical`, `semantic`, or
`hybrid`. Do not add verbose confidence prose unless measurements show it improves
agent decisions enough to justify its token cost.

### Exit criteria

- Negative queries do not produce ordinary-looking relevant results without an
  explicit abstention/uncertainty result.
- Positive-query recall stays within the measured acceptable boundary.
- Below-threshold vectors cannot contribute to RRF.
- Empty lexical and abstained semantic searches return the honest no-result path.
- Lean mode remains unchanged.

## 10. Phase 4 — Normalize AST search contracts

### Path filters

Confirm that `ast_search.filePattern` and `code_search.file_pattern` both use
normalized relative path substring semantics for directory fragments, filenames,
extensions, case behavior, Windows separators, and repeated substrings. Document
the same contract in both tool descriptions.

### Body output

Measure three options:

- B0: bounded approximately 25-line preview;
- B1: complete body;
- B2: bounded preview plus explicit truncation metadata and a targeted read path.

Use short functions, large classes, and targets whose useful implementation is
near the end. Record total calls, output bytes, latency, and whether the needed
content was obtained.

Retain B0 or B2 by default unless measurements demonstrate that full bodies
provide sufficient benefit without violating bounded-context goals. Do not silently
change the default output contract.

### Kind descriptions

Document the normalized kinds the implementation actually emits, including
language-specific forms where supported. Test TypeScript, Python, Rust, and other
supported extensions with focused fixtures. Do not advertise kinds that the
implementation does not return.

### Exit criteria

- Path-filter behavior is aligned and documented.
- Body output is accurately named and bounded by default unless a measured decision
  says otherwise.
- Kind filters are tested and documented across supported languages.

## 11. Phase 5 — Resolve session fallback isolation

### Candidates

- S0: retain `__default__` for explicitly single-session CLI use;
- S1: generate a process-unique fallback ID;
- S2: derive a stable fallback from the session/context object where the host
  supports it;
- S3: make the execution mode explicit and reject ambiguous multi-session use.

### Measurements

Run two sessions in one process, inspect a file in session A, attempt an edit in
session B, shut down A, and verify B's state. Measure cleanup, memory growth, and
single-session compatibility.

### Exit criteria

No session can inherit inspection evidence from another session unless the host
explicitly identifies them as the same session. Shutdown removes only the intended
state. Any fallback identity must remain deterministic for the lifetime of its
session and must not be guessed from unrelated process data.

## 12. Phase 6 — Review Git identity and commit observability

The placeholder issue is already fixed. This phase is optional policy work.

### Candidates

- G0: retain deterministic `Pi Agent <pi@agent.local>`;
- G1: read repository `user.name` and `user.email`, falling back to the deterministic
  local identity when either is unavailable;
- G2: expose the selected identity in structured commit details without changing
  the commit command.

### Matrix

Test no repository, repository with no commits, existing commit, configured
identity, missing identity, staged unrelated changes, nothing-to-commit, commit
failure, and file-change-before-commit. Confirm that the visible and structured
result distinguishes an applied working-tree edit from a committed edit.

### Exit criteria

No placeholder identity can enter history. The chosen policy is documented and
existing boolean compatibility remains intact.

## 13. Phase 7 — Evaluate embedding-load workflow

### Candidates

- E0: current foreground loading with bounded progress feedback;
- E1: background preload after explicit hybrid/full selection;
- E2: worker-based loading;
- E3: retain E0 and document the latency trade-off without adding a flag.

### Measurements

Measure lean startup, profile switching, first semantic search, cached model load,
uncached model load where available, UI responsiveness, RSS, CPU usage, cancellation,
and failure recovery. Do not download or initialize embeddings merely for routine
verification if the required cache/model is unavailable.

### Exit criteria

Do not add worker or preload complexity unless it materially improves measured
workflow behavior without violating lifecycle, cleanup, or output invariants. Lean
mode must not initialize embeddings.

## 14. Phase 8 — Optional maintainability work

These are not correctness requirements and remain deferred unless explicitly
approved after the preceding phases:

- split `src/index.ts` into wiring, indexing, command, and interceptor modules;
- expose RRF `k` as a bounded optional tuning parameter;
- standardize `agent-kernel` versus `pi-agent-kernel` naming;
- clone or enable broad Pi-lens scanner infrastructure;
- add a process-unique ID solely without first measuring the fallback problem.

If any optional item is selected, it must have its own focused test and must not
be bundled with unrelated formatting or cleanup.

## 15. Documentation updates

After behavior decisions are selected, update only the relevant documentation:

- `README.md` — verified feature claims and product naming;
- `docs/editing-and-verification.md` — atomic candidate validation, diagnostic
  uncertainty, and commit states;
- `docs/retrieval.md` — vector abstention, lexical fallback, path filters, body
  bounds, and confidence/evidence labels;
- `docs/architecture.md` — only if module boundaries or lifecycle behavior change;
- `docs/testing.md` and focused test documentation — experiment and acceptance
  coverage;
- this file — decisions, measurements, and final verification record.

Do not claim six-tier precedence, model comprehension, full-body output, semantic
confidence, or clean diagnostics unless the implementation and tests establish the
claim.

## 16. Focused test plan

Add or update only tests relevant to selected behavior:

- guard command-shape and zero-output boundaries;
- same-batch shell-read/edit behavior;
- per-session fallback isolation;
- patch-result contract and invalid candidate byte preservation;
- JSON, Python, JavaScript, and TypeScript candidate validation;
- vector threshold and RRF abstention with labeled fixtures;
- honest no-result output for gibberish;
- compact evidence-tier output if selected;
- AST path filters, body truncation metadata, and language-kind descriptions;
- configured Git identity and first-commit reporting;
- embedding profile switching only if the load policy changes;
- terminal-width safety for any changed renderer.

## 17. Verification protocol

### During implementation

1. Read the relevant source and focused test immediately before every edit.
2. Run the smallest relevant experiment or test.
3. Inspect the result and stop on failure or unexpected output.
4. Run bounded primary diagnostics only for changed implementation files when an
   already-ready client is available.
5. Do not run the complete suite after each change.

### Final verification

1. Run all newly added focused tests.
2. Run affected existing sections.
3. Run bounded primary diagnostics for changed implementation and test files.
4. Run the complete suite exactly once.
5. Run `git diff --check`.
6. Review complete diff, name status, and retained-file intent.
7. Confirm `src/ui/tui_utils.ts` was not changed by this work.
8. Confirm terminal-width tests remain valid.
9. Confirm unavailable, timeout, unsupported, and inconclusive states were not
   reported as clean.
10. Record exact test counts and exit codes in this file.
11. Only then decide whether an intentional commit is appropriate.
12. Check remote synchronization separately; do not push without explicit
    instruction.

## 18. Execution order

```text
1. Preserve and classify the dirty worktree.
2. Confirm current baseline facts with bounded focused experiments.
3. Decide the guard evidence contract.
4. Document the atomic patch-result contract.
5. Build the labeled retrieval fixture and choose vector abstention/RRF behavior.
6. Normalize and document AST contracts.
7. Decide session fallback isolation.
8. Decide optional Git identity policy.
9. Measure embedding-load alternatives.
10. Apply only selected production changes.
11. Add focused regressions.
12. Update documentation.
13. Run final verification once.
14. Review the complete diff and commit intentionally, if requested.
15. Check remote state and await push instructions.
```

## 19. Decision record

### Completed and retained

- Metadata-only shell commands and non-content grep/rg modes are excluded from guard evidence.
- Candidate syntax is validated before target writes.
- Invalid single- and multi-block edits preserve target bytes.
- AST filters use normalized relative paths.
- Custom edit verification owns its lifecycle; compatibility write handling remains.
- Detailed commit states are exposed without breaking the boolean helper.
- Vector-cache integrity checks preserve BM25 fallback.
- Unsupported six-tier precedence claims were removed.
- Initial vector abstention is applied at a measured 0.6 floor before RRF.
- Non-content grep/rg modes are excluded from shell inspection evidence.
- Fallback session IDs are isolated per process/context.
- AST body truncation is explicitly reported.
- Search results expose lexical/semantic/hybrid signal labels.
- Compact output and terminal-width constraints remain protected.

### Explicitly unresolved pending measurement or approval

- Whether shell evidence should become stricter than classified command shape.
- Larger labeled-corpus calibration of the initial vector cosine threshold.
- Full AST body output versus bounded preview metadata.
- Configured Git identity policy.
- Foreground versus background/worker embedding loading.
- RRF `k` configurability.
- `src/index.ts` decomposition.
- Public naming consistency.

### Current verification record

The initial implementation pass added focused regressions for non-content shell
search modes and vector abstention. It also added the patch-result contract,
normalized code-search paths, isolated fallback session IDs, AST body truncation
metadata, and lexical/semantic/hybrid signal labels. Focused checks for the
changed behavior passed where executed; the complete final verification protocol
in Section 17 remains pending and must record exact outputs before release. No
unavailable or inconclusive check may be labeled clean.
