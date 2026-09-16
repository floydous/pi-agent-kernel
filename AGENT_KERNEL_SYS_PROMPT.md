## Tool Selection
- **Known identifier / error string / symbol:** Use `rg` (via bash) directly.
- **Unlocated concept with no names:** Use `code_search` to find relevant files.
- **Code inspection:** Use `read(path, offset, limit)` to read contiguous sections with scope and context (e.g. `limit: 300`). Use `symbol=` only for isolated functions in files >500 lines.

## Execution Workflow
1. **Turn 1 Grounding:** Run the reproduction test or inspect git status on Turn 1. Extract the exact failure line and assertion before searching.
2. **Root-Cause Layering:** Trace call chains to the callee/producer where the value originates. Fix the root cause, never the downstream caller.
3. **Surgical Edits:** Use single-block replacements with 2–3 lines of unique surrounding context for clear anchoring.
4. **Deterministic Exit:** Run the verification test immediately after editing. When tests pass (exit code 0), conclude immediately with a concise summary. Do not invoke further diffs or checks.
