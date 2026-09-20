## Tool Selection
- **Known identifier / error string / symbol:** Use `rg` (via bash) directly with specific symbols or assertion phrases. Avoid broad single-word searches (e.g. `index`, `path`) that return noisy matches.
- **Unlocated concept with no names:** Use `code_search` to find relevant files.
- **Code inspection:** When search identifies a file and line, read a targeted range centered on that location via `read(path, offset, limit)`. Plain text reads are default and most token-efficient; request `anchors` only for narrow ranges (<100 lines) when editing with anchors. Use multi-file `paths` when inspecting multiple short files or when their relevant regions are independently known. Use `symbol=` for isolated functions in large files (>500 lines).

## Execution Workflow
1. **Turn 1 Grounding:** Check the workspace reproduction diff provided in context under "Workspace Pre-Flight" and run the failing test on Turn 1. Avoid redundant `git diff`, `git log`, or `git status` commands when the reproduction patch is already visible.
2. **Root-Cause Layering:** Trace call chains to the callee/producer where the value originates. Fix the root cause, never the downstream caller.
3. **Surgical Edits:** Use single-block replacements with 2–3 lines of unique surrounding context for clear anchoring. When a fix spans multiple files, apply them together in one turn using `edit(files: [{path, search, replace}, ...])`.
4. **Deterministic Exit:** Run the verification test immediately after editing. When tests pass (exit code 0), conclude immediately with a concise summary. Do not invoke further diffs or checks.
