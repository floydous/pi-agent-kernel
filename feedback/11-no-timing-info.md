# 11. No timing information in tool results — real for the extension, scope boundary matters

## Factual re-test

The extension's tool results contain content and optional details, but no
standard elapsed-time or output-size footer. Timing is available externally for
experiments: on the same 110-chunk fixture, one local run measured about 570 ms
for lean indexing, 36.7 s for hybrid, and 38.8 s for full indexing. These are
machine- and cache-dependent measurements, but they prove that cost differences
exist and cannot be inferred from result shape alone.

The current repository does not control the outer `functions.read`/`bash` API
wrapper, so it cannot add timing metadata to every host tool result. It can add
operation timings to its own `details` fields, but that would not solve the
feedback's broader harness request.

## Workflow comparison

**Current:** the agent chooses tools without latency/size telemetry and learns
costs only through external observation or session logs.

**Proposed footer:** every result gets elapsed milliseconds and bytes. This would
improve routing decisions, but only if the measurement is clearly labeled as
wrapper/tool time and does not become noisy prompt content.

**Best local boundary:** put optional `elapsedMs`, `bytes`, active retrieval
profile, and cache-hit status in `details` for extension-owned operations. Put a
human-readable footer and cumulative turn/session counters in host middleware.

## Verdict

**Issue confirmed at the host/harness boundary; unresolved by this repository.**
The repository can expose local operation metadata, but a universal timing footer
belongs in Pi's tool-result middleware.

Headroom's methodology supports this observability-first approach: it reports
compression metrics, labels counterfactual output savings as estimated, and uses
measured holdouts when a measured number is required. Timing and token claims
should follow the same distinction.
