# Navigation tool feedback — evidence-backed status

This folder records feedback collected while using the navigation tools against
an OpenRouter Gateway repository and then validating the claims against this
extension's real fixtures and implementations.

## Status convention

- `*-done.md`: implemented in the current working tree, or the original issue
  was verified as an external host boundary rather than an extension defect.
- unsuffixed files: the issue is real or partially real, but the proposed
  change is deferred, intentionally rejected, or needs a larger product/API
  decision.

The suffix is not a claim that every idea in the file is accepted. Read
`14-research-findings.md` for the experiments, measured workflow comparisons,
and Headroom/Manus methodology synthesis.

## Implemented high-impact changes

| Feedback | Evidence-backed action |
|---|---|
| `01` | Entry-point priority, trivial-data demotion, file-size and entry-point orientation in `get_repo_map` |
| `04` | Adaptive bounded `code_search` output with explicit full/preview/summary modes; retrieval profiles benchmarked (hybrid is the measured vector trade-off; lean remains available) |
| `09` | AST-derived chunk spans and bounded output metadata; regression coverage |
| `12` | Bash clamp marks omitted lines and gives spillover path; full output remains on disk |
| `13` | Existing useful behaviors preserved and regression-tested |
| `16` | Default code scope excludes prose; explicit `prose`/`all` escape hatches remain |

## Verified but deferred/partial findings

- `02`, `10`: single-call navigation/composite descriptions would improve
  ergonomics, but measured token savings are small; any version should be
  bounded and opt-in.
- `03`: shell grep is a real escape hatch, but existing `rg` and LSP references
  cover the tested workflow at low cost.
- `05`: exact content dedup works; changed-parameter/content-equivalent cases
  exist, but semantic query merging is unsafe without labeled evaluation.
- `06`: coordinate LSP navigation works on meaningful identifiers; provenance,
  output normalization, and directory diagnostics remain inconsistent.
- `07`: exact-read versus fuzzy-search friction is confirmed and small; bounded
  suggestions are safer than fuzzy extraction.
- `08`: the guard is now range-aware and rejects search evidence by design;
  search-as-read should not be enabled silently.
- `11`: timing metadata is absent from extension results, while universal tool
  timing belongs to host middleware.
- `14`: research synthesis and benchmark limitations.
- `15`: read-after-write repetition exists, but unconditional in-memory reuse
  would undermine freshness verification.

## External methods incorporated

Headroom contributes content routing, AST-aware compression, live-zone/stable
prefix handling, reversible CCR retrieval, hash-keyed dedup, and measured versus
estimated savings. Manus contributes stable deterministic append-only context,
restorable filesystem-backed memory, explicit tool-contract stability, error
retention, and recency/plan recitation. This repository adopts the compatible
low-risk parts and rejects opaque semantic substitution without an accuracy test.

## Validation

The completed implementation passes:

```text
npm run typecheck
npm test                    # 36 passed, 0 failed
 git diff --check
```

No commit or push was performed.
