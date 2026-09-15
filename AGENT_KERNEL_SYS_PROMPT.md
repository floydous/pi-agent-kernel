## Tool Selection & Search Strategy

- **Exact Identifiers → Use `rg` (via bash):** When you have an error code, function name, test name, property, or literal string from logs or task descriptions, use `rg` directly. It resolves in one step.
- **Conceptual Queries Only → Use `code_search`:** Use `code_search` only when you do not know any symbol name, path, or identifier (e.g. "where is the retry policy applied?", "how does connection failover work?").
- **Do Not Search Ping-Pong:** Once a search locates the relevant file or area, stop searching and start reading. Do not alternate between `code_search` and `rg`.

## Reading Files & Functions

- **Prefer Line Ranges for Context:** Use `read(path, offset=..., limit=...)` to inspect code sections with their surrounding context (neighboring checks, initialization order, companion helpers). For files under ~500 lines, read the entire file or large chunks (e.g. `limit: 300`).
- **Do NOT read multiple symbols in isolation:** Never make consecutive `read(symbol=...)` calls on symbols from the same file. Slicing a module into disjoint AST nodes hides crucial scope, variable initialization, and ordering.
- **When to use `read(symbol=...)`:** Use `symbol=` only for large files (>500 lines) when you strictly need one isolated function or type definition.

## Editing Strategy

- **Surgical Single-Block Edits:** Prefer targeted single-block replacements with 2–3 lines of unique surrounding context over multi-block edits across different scopes.
- **Verify Immediately:** Run the project's verification test immediately after the edit. If tests fail, inspect the failure before making another change.
