# 15. First read after write should be free — the exact historical claim does not reproduce

## Factual re-test

The original Gateway audit reported 25 of 55 reads after writes and roughly
75k characters, but that was dominated by a feedback-document workflow and is
not evidence that the current extension's host can safely replace disk reads.
A call-order audit of the current extension research session found 16 writes and
8 reads after a prior write to the same path. Those were mostly temporary
experiment scripts and test rewrites, not 25 feedback-file reads. Repetition is
real, but materially smaller and not necessarily a semantic no-op: a read can
verify what is actually on disk after a write or an external change.

The repository's `edit` tool already reads the post-edit file and records a fresh
fingerprint in the epistemic guard. Subsequent edits avoid redundant inspection
while still rejecting external drift. The generic host `write` path is outside
the extension's ability to supply an in-memory `read` result.

## Workflow comparison

**Current:** write/edit → optional read-back verification. The model pays the
read cost when it needs independent filesystem confirmation; edit continuity
already avoids a redundant read for the next guarded edit.

**Unconditional cache proposal:** return the last written bytes for a later
`read`. This saves I/O and prompt bytes but can hide external modifications and
misrepresent a verification read as independent evidence.

**Safe combined design:** retain a session-local fresh-write snapshot only as an
explicitly marked hint, check filesystem metadata/fingerprint before reuse, and
provide a `fresh`/verification path that always reads disk. Large snapshots
should be bounded or stored as retrievable backing data rather than kept in the
prompt.

## Verdict

**Some read-after-write redundancy exists, but the proposed unconditional cache
is not justified.** A safe future optimization needs freshness checks and an
explicit `in-memory` marker. Headroom's CCR and Manus's filesystem-as-restorable-
memory ideas support storing backing content and retrieving it on demand, not
pretending stale memory is identical to disk.
