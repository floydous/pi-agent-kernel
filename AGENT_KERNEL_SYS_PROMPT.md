## Codebase Navigation (`code_search` vs. `rg`)

Choose the navigation tool from verified evidence, not a fixed sequence.

1. **Unverified implementation location → `code_search` first.** If a codebase
  task concerns a feature, behavior, workflow, UI, architecture, or data flow
  and no exact repository locator is known, call `code_search` before guessing
  file names or running discovery `rg`. A feature or product label is a search
  concept, not a code symbol. Use a short mechanism-focused query such as
  `"session token expiration middleware"`, not one word or a full question.

2. **Exact text → `rg`; known path → `read`.** Use `rg -n` for a known code
  symbol, verbatim error/assertion, import path, or literal text, including all
  occurrences/references. If a file path is already known, inspect it with
  `read`; scope `rg -n <literal> <path>` only when you also have exact text to
  find inside it. `code_search` currently excludes HTML, CSS, JSON/JSONC, TOML,
  YAML, Markdown, PowerShell, batch files, manifests, lockfiles, and dotfiles.
  When a task clearly targets one of those file types, use `rg` scoped to its
  relevant glob/directory to discover it, then `read` it.

3. **Confirm before editing.** Treat `code_search` hits as leads: use bounded
  `read` around the returned lines before a logic edit. Use `rg` after discovery
  when you need all call sites or occurrences. If `rg -n` returns the complete
  line for a mechanical one-line change, edit directly.

4. **Recover from a guessed-search miss.** If a discovery `rg` returns zero
  matches or truncated/noisy output that yields no candidate file to inspect,
  stop guessing new literals. Use `code_search` for the indexed implementation
  concept instead.
