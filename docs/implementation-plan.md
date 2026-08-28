# Agent-Kernel Correctness and Reliability Implementation Plan

**Status:** Implementation complete (selected scope)
**Scope:** Feedback-driven correctness, reliability, retrieval, and documentation work
**Repository:** `pi-agent-kernel`

## 1. Objective

Improve the extension's safety and reliability while preserving its central design
priority:

> Bare-minimum token usage, maximum performance, and maximum reliability across
> agent work.

The implementation must be driven by measured behavior rather than instinct,
assumption, or unverified hypotheses. Candidate designs will be exercised through
identical controlled workflows before a final option is selected.

This plan addresses the verified feedback findings while avoiding unrelated
refactors and preserving existing public APIs unless a deliberate behavior change
is documented and tested.

## 2. Verified baseline

The following observations were reproduced against the current implementation:

### 2.1 Epistemic guard

`extractInspectedFilesFromCommand()` currently records an existing file for all of
these command forms:

```text
ls sample.ts
stat sample.ts
wc -l sample.ts
grep -c value sample.ts
cat sample.ts
head -n 1 sample.ts
```

After `grep -c absent sample.ts`, the current guard allows an edit. The current
implementation therefore records file-path references, not verified content
exposure.

The existing tests cover the positive `cat file` case but do not distinguish
content-reading commands from metadata-only commands or zero-output searches.

### 2.2 Syntax verification ordering

The current patch functions write the composed replacement before the edit tool
runs syntax verification. A deliberately invalid replacement was reproduced:

```text
Original:    export const value = 1;
Replacement: export const value = {;
```

Observed behavior:

```text
patch result: success
file on disk: invalid content
syntax result: failed
```

The current order is therefore:

```text
read -> compose -> write -> verify
```

rather than an atomic:

```text
read -> compose -> verify -> write
```

### 2.3 Retrieval implementation

The current vector search includes up to 100 vector candidates in RRF without a
minimum cosine-similarity threshold. This must be tested against a labeled query
set before choosing a threshold or abstention policy.

`ast_search.filePattern` currently checks only the directory entry basename,
while `code_search.file_pattern` checks the relative chunk path.

`ast_search.includeBody` currently returns a maximum 25-line window, although its
name may suggest a complete body.

### 2.4 Current source state

The current worktree contains earlier intentional changes and unrelated changes,
including the protected `src/ui/tui_utils.ts` modification. Existing changes must
not be reverted wholesale or reformatted incidentally.

The feedback's literal `[EMAIL]` placeholder is not present in the current
`src/editing/git-verify.ts`; that specific report is stale or already fixed. The
remaining commit-observability question still requires testing.

## 3. Constraints

Implementation notes from the baseline experiments are recorded in Section 17.

- Do not use guesses, assumptions, or hypotheses as implementation justification.
- Reproduce every applicable feedback claim against the current source first.
- Use controlled experiments for alternatives that change workflow behavior.
- Preserve bare-minimum token usage and avoid unnecessary output.
- Do not automatically run the full test suite, broad scanners, embeddings, or
  repository-wide analysis after each edit.
- Run focused checks during development and the full suite only at the final
  verification checkpoint.
- Do not spawn a language server solely for post-edit verification; reuse only an
  already-ready client.
- Never report unavailable, timed-out, unsupported, or inconclusive checks as
  `clean`.
- Preserve compact grouped verification output.
- Preserve the terminal-width invariant for custom rendered lines.
- Leave the unrelated `src/ui/tui_utils.ts` modification untouched.
- Preserve read-before-write behavior unless the selected guard policy deliberately
  changes its evidence contract.
- Do not treat `/oracle` as safe for untrusted input; it remains an explicitly
  user-invoked shell escape hatch.
- Do not clone all of Pi-lens or add broad background scanners.
- Do not use standalone scripts to rewrite repository code or imports.
- Before editing an existing file, read it immediately beforehand and use the
  actual edit tool.
- Preserve compatibility entry points and existing public APIs where possible.
- Do not commit or push until the final diff and verification state are reviewed.

## 4. Experimental method

Every candidate that affects agent workflow will be evaluated with the same
controlled fixture and workflow matrix.

For each case, record:

- Exact input and candidate policy.
- Allowed/rejected result.
- Reason and visible output.
- Filesystem state before and after.
- Byte equality where relevant.
- Git state before and after.
- Tool-call count.
- Output bytes and lines.
- Elapsed time.
- Recovery steps required.
- Whether the result is definitive or uncertain.

The baseline is a control group, not a desired outcome. A candidate is selected
only after its measured trade-offs are compared with the other candidates.

Candidate implementations will be kept isolated during comparison. Production
changes will be applied only after the decision gates in Section 12 pass.

## 5. Phase 0: Baseline and fixture preparation

### Actions

1. Preserve the current dirty worktree and classify each existing modification as:
   - intentional and in scope;
   - intentional but unrelated;
   - formatting-only or migration-related;
   - deleted/untracked artifact requiring no action;
   - unresolved.
2. Do not restore or delete the feedback files, deleted artifacts, or unrelated
   TUI change as part of this plan.
3. Add focused experiment fixtures and tests only after reading the relevant test
   and implementation files.
4. Reproduce the current guard, patch ordering, retrieval, AST filtering, and
   commit-state behavior with explicit outputs.
5. Mark each feedback item as `confirmed`, `already fixed`, `not reproducible`,
   `not applicable`, or `not yet tested`.

### Verification checkpoint

A baseline record exists for each applicable issue, and no production behavior has
changed.

## 6. Phase 1: Compare epistemic guard policies

The guard cannot prove that a model understood file contents. It can only track
observable evidence. The selected contract must use accurate terminology.

### Candidate A0: Current path-reference policy

Control group. Any qualifying command token or internal search/read result records
the file in one inspection set.

### Candidate A1: Known content-reader classification

Record shell evidence only for commands classified as content readers, such as:

```text
cat, head, tail, sed, awk, grep, rg, less, more
```

Do not record metadata-only operations such as:

```text
ls, stat, file, wc, chmod, test -f, find
```

This measures whether command classification alone improves false-permission
behavior while preserving the current preflight timing.

### Candidate A2: Completed shell-result evidence

Record shell content evidence only after a successful shell result is returned.
This prevents a same-batch shell-read plus edit from using a result the agent has
not yet received.

### Candidate A3: Native-tool evidence only

Only the extension's own `read`, `read_symbol`, `ast_search`, and `code_search`
results satisfy the guard. Shell commands never satisfy it.

### Candidate A4: Evidence categories

Track evidence types separately rather than collapsing them into one boolean:

```ts
type InspectionEvidence =
  | "content-read"
  | "symbol-read"
  | "ast-search"
  | "code-search"
  | "shell-content-read";
```

The test must determine whether this additional state improves correctness enough
to justify its complexity and token/workflow cost.

### Guard experiment matrix

Run every candidate against:

| Workflow | Measurement |
| --- | --- |
| Native `read` then edit | allow/reject, calls, output |
| `read_symbol` then edit | allow/reject, calls, output |
| AST search then edit | allow/reject, calls, output |
| Code search then edit | allow/reject, calls, output |
| `cat file` then edit | allow/reject, calls, output |
| `grep` with zero output then edit | allow/reject, calls, output |
| `wc file` then edit | allow/reject, calls, output |
| `ls file` then edit | allow/reject, calls, output |
| `stat file` then edit | allow/reject, calls, output |
| Same-batch `cat` plus edit | allow/reject, calls, output |
| Search result for unrelated symbol then edit | allow/reject, calls, output |
| New-file write | allow/reject |
| File inspected in another session | allow/reject |
| Case variants on Windows and POSIX behavior | allow/reject |

### Decision criteria

Select the smallest policy that:

- rejects clearly metadata-only and zero-content evidence;
- does not create unexplained false rejections in common workflows;
- gives same-batch behavior an explicit, measured contract;
- does not claim to prove model comprehension;
- preserves per-session isolation;
- keeps output and latency within the measured baseline budget.

Then update names, comments, tests, and documentation to match the observed
contract.

## 7. Phase 2: Compare atomic edit designs

### Candidate B0: Current behavior

Control group:

```text
read -> compose -> write -> verify
```

### Candidate B1: In-memory candidate verification

Compose the replacement without writing, validate the candidate content, then
write only if the validation is clean.

Add a content-oriented syntax-validation entry point while retaining
`checkSyntax(filePath)` compatibility. The implementation must test the actual
verifiers used for TypeScript/JavaScript, JSON, and Python rather than assume that
all validators accept strings directly.

### Candidate B2: Temporary-file verification

Compose in memory, write a temporary candidate, run the existing file-oriented
verifier, remove the temporary file, and replace the target only after successful
validation.

Measure temporary-file side effects, including Python cache artifacts, permissions,
line endings, symlinks, path-sensitive behavior, and cleanup after failure.

### Candidate B3: Backup and rollback

Write the target, retain a backup, verify, and restore on failure. This is included
for measurement only; it must not be considered atomic without testing interruption
and concurrent-modification behavior.

### Atomic edit test matrix

Each candidate must be exercised with:

- Valid TypeScript and invalid TypeScript delimiters.
- Unterminated strings and comments.
- Valid and invalid JSON.
- Valid and invalid Python.
- JavaScript syntax.
- Multi-block patch where an intermediate block applies but a later block fails.
- CRLF input and UTF-8 content.
- Empty replacement.
- Existing file and new file.
- Existing uncommitted working-tree changes.
- File changed by another process after the initial read.
- Failure followed by a second edit attempt.
- Permission and symlink behavior where supported by the platform.

### Decision criteria

A selected design must satisfy the hard safety invariant:

> If syntax validation fails, the target remains byte-for-byte unchanged.

It must also preserve valid edits, CRLF behavior, useful diffs, and clear error
states without requiring unnecessary agent recovery calls. Concurrent file changes
must not be silently overwritten; if the selected design cannot safely handle a
race, it must reject the write explicitly.

LSP diagnostics remain post-write diagnostics unless experiments establish a
separate strict mode that is both reliable and compatible with the token and
latency goals. Unavailable or inconclusive diagnostics must not block a valid edit
or be reported as clean.

## 8. Phase 3: Consolidate edit verification and commit reporting

The current code has edit verification and commit behavior in both
`src/tools/edit_tool.ts` and the `tool_result` interceptor in `src/index.ts`.
This phase compares the behavior before consolidating it.

### Actions

1. Instrument or test whether both paths can run for the same edit.
2. Identify duplicate syntax checks, LSP calls, commits, or result mutations.
3. Select one owner for edit verification and commit reporting.
4. Preserve output clamping separately from edit lifecycle logic.
5. Keep already-ready-client-only LSP reuse for post-edit checks.

The likely target boundary is for `edit_tool.ts` to own patch composition,
epistemic validation, syntax validation, writing, diagnostics, and commit result
construction, while the interceptor handles only behavior that genuinely belongs
at the result boundary. This is a candidate to verify, not an assumption to
apply without measurement.

### Commit result comparison

Test:

- Non-Git directory.
- Git repository with no commits.
- Git repository with an existing commit.
- Nothing to commit.
- Configured Git identity.
- Missing Git identity.
- Existing unrelated staged changes.
- Commit command failure.
- File changed before commit.

Compare the current boolean result with a detailed result such as:

```ts
type CommitState =
  | "committed"
  | "not_git_repo"
  | "failed"
  | "nothing_to_commit";
```

The selected result must never present a working-tree-only edit as fully
committed. Its visible and structured output must distinguish commit success from
an edit that was applied but not committed.

The current deterministic local Git identity is not changed merely because the
stale `[EMAIL]` report mentioned a different placeholder. Any identity change
requires measured compatibility results and an explicit documentation update.

## 9. Phase 4: Compare retrieval abstention and threshold policies

Build a labeled query corpus before choosing a threshold.

### Positive query categories

- Exact symbol names.
- Exact error messages.
- Known conceptual descriptions.
- Cross-language queries.
- Documentation-only targets.
- Source-only targets.

### Negative query categories

- Random gibberish.
- Plausible absent identifiers.
- Correct concepts with no implementation in the repository.
- Terms present only in unrelated files.

For each query, capture:

- BM25 result count.
- Highest and top-five vector cosine scores.
- RRF ordering.
- Relevant-result count.
- False-positive count.
- Latency.
- Output bytes and lines.

### Candidate D0: Current unrestricted vector contribution

Control group.

### Candidate D1: Fixed cosine threshold

Test a measured range of thresholds for each embedding dimension. Values such as
`0.70` or `0.75` are test inputs, not preselected answers.

### Candidate D2: Query-level vector abstention

If the highest vector score does not meet the measured confidence boundary, drop
the vector signal entirely and use BM25 only.

### Candidate D3: Evidence-tier output

Expose compact signal information such as:

```text
Signal: lexical
Signal: semantic
Signal: hybrid
No sufficiently supported result
```

Measure whether the interpretation benefit justifies the added output bytes.

### Decision criteria

Known-negative queries must not produce normal-looking relevant results without an
explicit low-confidence/uncertain classification. Positive-query recall must not
regress beyond the measured acceptable boundary. The selected implementation must
prevent sub-threshold vector candidates from influencing RRF, not merely hide the
score after ranking.

If no lexical or above-threshold semantic evidence exists, return the existing
honest no-result response.

## 10. Phase 5: Normalize AST search behavior

### Path filter experiment

Run both tools against:

```text
ast_search(filePattern: "safety")
code_search(file_pattern: "safety")
```

Also test full relative paths, basenames, extensions, case variants, Windows
separators, and repeated substrings. Select one consistent path-substring contract
unless measurements show a documented reason not to.

### Body-output experiment

Compare:

- E0: current 25-line bounded preview.
- E1: complete symbol body.
- E2: bounded preview with explicit truncation metadata and a `read_symbol`
  follow-up path.

For short functions, large classes, signature-only requests, and implementation
details near the end, record total calls, total output bytes, latency, and whether
the required information was obtained.

The name and documentation must accurately describe the selected behavior. A full
body is not automatically preferable because it may increase context usage when a
signature or short preview is sufficient.

### Kind documentation

Document normalized kinds actually produced across supported languages, including
language-specific forms such as `struct`, `trait`, `enum`, and `impl` where the
implementation emits them. Do not advertise unsupported values.

## 11. Phase 6: Validate vector-cache integrity

Test the cache with:

1. Valid unchanged metadata and vectors.
2. Reordered chunks with unchanged vector bytes.
3. Removed chunk.
4. Added chunk.
5. Changed vector dimension.
6. Truncated vector file.
7. Different vector ordering.
8. Changed file hashes.
9. Corrupt metadata.

Store deterministic metadata covering chunk IDs, ordering, vector count, and
vector dimension. A hash may be used if its exact inputs are documented and tested.

On mismatch:

- reject the vector cache;
- retain safe BM25/chunk data when possible;
- never silently associate a vector with another chunk.

## 12. Documentation corrections

Update documentation only after behavior is selected and tested.

### Required changes

- Remove the unsupported “6-tier instruction precedence” claim unless a concrete
  implementation and tests establish six tiers.
- State the exact guard evidence contract; do not claim to prove comprehension.
- Document atomic syntax rejection and the behavior of diagnostic uncertainty.
- Document commit result states.
- Document vector abstention/threshold behavior and lexical fallback.
- Document file-filter semantics.
- Document whether AST body output is bounded or complete.
- Preserve the explicit priorities of minimum token usage, performance, and
  reliability.

Likely files:

```text
README.md
docs/README.md
docs/architecture.md
docs/editing-and-verification.md
docs/retrieval.md
docs/testing.md
tests/README.md
```

## 13. Verification strategy

### During implementation

Run only the focused experiment or regression test relevant to the current
candidate. Use bounded diagnostics for changed implementation files where an
already-ready client is available. Do not run broad scanners after each edit.

### Final verification

After all candidate decisions are recorded and the selected behavior is applied:

1. Run all new focused regression tests.
2. Run affected existing sections.
3. Run bounded diagnostics for changed files.
4. Run the complete test suite once.
5. Run `git diff --check`.
6. Review the complete diff and status.
7. Confirm no protected unrelated change was modified.
8. Confirm unavailable or inconclusive checks were not reported as clean.
9. Confirm documentation matches the selected behavior.

A passing test suite alone is insufficient; the experimental workflow results and
filesystem/Git observations must also be reviewed.

## 14. Decision gates

A behavior change may be retained only if it passes all applicable gates:

### Safety

No clearly uninspected file is permitted, and a failed syntax validation leaves the
target byte-for-byte unchanged.

### Workflow

Common agent workflows remain understandable and do not incur unnecessary calls
or output.

### Reliability

Failure, timeout, unavailable, and inconclusive states remain explicit and
recoverable.

### Performance

Measured latency, memory, and output remain consistent with minimum-token and
maximum-performance priorities.

### Compatibility

Existing public APIs and compatibility commands continue to work unless the
behavior change is deliberate, tested, and documented.

### Documentation

Every externally visible behavior is described accurately.

## 15. Deferred work

These items remain out of scope unless measurements show they are required for a
selected fix:

- Splitting `src/index.ts` into command, indexing, and interceptor modules.
- Exposing RRF `k` as a tuning parameter.
- Renaming the package or directory.
- Moving embedding loading to a worker.
- Adding a process-unique fallback session identifier.
- Cloning broad Pi-lens scanner or diagnostic infrastructure.

## 16. Execution order

```text
1. Preserve and classify the current worktree.
2. Reproduce and record the baseline.
3. Compare epistemic guard policies.
4. Compare atomic edit policies.
5. Compare edit/commit ownership and commit reporting.
6. Build the labeled retrieval corpus and compare abstention policies.
7. Compare AST filter/body contracts.
8. Test vector-cache integrity.
9. Select implementations from measured results.
10. Apply the selected production changes.
11. Update focused tests and documentation.
12. Run final focused and full verification.
13. Review diff/status and commit intentionally.
```

The baseline experiments selected the smallest verified changes currently
implemented: classify shell command shapes as content-read evidence, validate
patch candidates before writing, normalize AST path filtering, expose explicit
commit outcomes, and reject incomplete vector-cache mappings. The fixed vector
The fixed vector threshold remains deferred until a labeled retrieval corpus establishes a
measured boundary; no unsupported threshold claim is part of the selected scope.

## 17. Implementation record

### Completed

- Baseline guard and syntax-order issues reproduced.
- Shell metadata commands no longer count as inspection evidence.
- Candidate single- and multi-block patches are syntax-validated before writing.
- Invalid patch regression tests verify byte preservation.
- AST path filtering now uses normalized relative paths.
- AST tool descriptions identify the path-filter and 25-line body-preview
  contracts.
- Edit verification is no longer duplicated for the custom `edit` tool by the
  result interceptor; the compatibility `write` path remains unchanged.
- Detailed commit outcomes are available through `autoCommitFileDetailed()` while
  the existing boolean helper remains compatible.
- Vector cache loading validates profile, IDs, dimensions, exact byte length, and
  a content hash; invalid vector data falls back to BM25.
- The fixed vector threshold remains deferred because a labeled retrieval corpus
  has not yet established a measured confidence boundary.
- README and focused documentation no longer claim six-tier instruction
  precedence and document the selected edit/retrieval behavior.

### Deferred pending measurement

- A fixed vector cosine threshold or query-level vector abstention policy.
- Full AST body output versus explicit bounded-preview metadata.
- Same-batch completed-result guard semantics.
- Broader commit identity-policy changes.

### Verification recorded so far

The affected focused sections passed after the implementation changes:

```text
Sections 5, 6, 7, 8, 10, 13, 20, and 25: passed
Primary diagnostics for changed implementation and focused test files: 0 errors
```

The complete focused suite passed with zero failures. Targeted TypeScript
compilation and primary diagnostics reported no errors, and `git diff --check`
reported no whitespace errors. The implementation commits are complete. The
remaining dirty worktree contains pre-existing unrelated changes and artifacts
that were not altered or discarded; they require separate ownership review.
