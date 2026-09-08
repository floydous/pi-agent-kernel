# Update log

This log records the evidence-driven progression of the feedback work.

## v1: Initial feedback

The findings began as intuition and targeted probes against a 10,400-line Rust
Gateway. Several early claims were intentionally left open: navigation friction,
content-blind editing, LSP fallback quality, code-search ranking, and context
costs.

## v2: Package install and re-test

After the relevant packages were installed, re-tests showed:

- `rrf_k` was active;
- LSP references returned richer results;
- edit coverage became range-aware;
- exact content dedup behaved conservatively.

The feedback was revised rather than treating the first observations as final.

## v3: Split findings

The original consolidated document was split into one numbered file per finding.

## v4: Session-log audit

A real session audit measured tool calls, output characters, duplicate results,
read-after-write patterns, and navigation sequences. It identified code-search
output and prose pollution as the highest-impact problems, while downgrading
workspace grep and two-step navigation.

## v5: Controlled implementation experiments

The extension fixtures were used to compare prose scopes, adaptive output,
pre-ranking filters, AST chunk boundaries, repository-map orientation, and
retrieval profiles. The high-impact changes were implemented with regression
coverage.

## v6: Unresolved-feedback deep dive

Each unresolved item was re-tested against current code and fixtures. The final
findings distinguish:

- confirmed gaps worth future work;
- issues that are real but too small for new abstractions;
- old claims disproved by the current implementation;
- host/harness limitations outside this repository.

Headroom's public README/docs and Manus's context-engineering article were read
and compared. The compatible methods—content routing, reversible backing
storage, stable prefixes, deterministic append-only identity, and explicit
metrics—were incorporated into the final prioritization without adding a new
compression dependency or semantic cache.

## Key lesson

The useful innovation was not “add every suggested tool.” It was measuring the
workflow first, preserving exact/retrievable backing content, and adding only
the smallest defaults that removed demonstrated context waste. The remaining
unsuffixed files document evidence-backed deferrals, not unverified speculation.
