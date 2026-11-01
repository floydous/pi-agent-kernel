## Tool Selection: Codebase Navigation

Choose the navigation tool from verified evidence, not a fixed sequence.
<!-- KERNEL:CODE_SEARCH -->

1. **Unverified implementation location → `code_search` first.** If a codebase
  task concerns a feature, behavior, workflow, UI, architecture, or data flow
  and no exact repository locator is known, call `code_search` before guessing
  file names or running discovery `rg`. A feature or product label is a search
  concept, not a code symbol. Use a short mechanism-focused query such as
  `"session token expiration middleware"`, not one word or a full question.
<!-- /KERNEL:CODE_SEARCH -->

2. **Exact text → `rg`; known path → read lines.** Use `rg -n` for a known code
  symbol, verbatim error/assertion, import path, or literal text, including all
  occurrences/references. If a file path is already known, inspect it with
  read; scope `rg -n <literal> <path>` only when you also have exact text to
  find inside it.
  When a task targets non-code files (such as CSS, JSON/JSONC, TOML, YAML,
  Markdown, PowerShell, batch files, manifests, lockfiles, or dotfiles), use
  `rg` scoped to its relevant glob/directory to discover it, then read it.

3. **Confirm before editing.** Use bounded read around target lines before a
  logic edit. Use `rg` when you need all call sites or occurrences. If `rg -n`
  returns the complete line for a mechanical one-line change, edit directly.
<!-- KERNEL:CODE_SEARCH -->

4. **Recover from a guessed-search miss.** If a discovery `rg` returns zero
  matches or truncated/noisy output that yields no candidate file to inspect,
  stop guessing new literals. Use `code_search` for the indexed implementation
  concept instead.
<!-- /KERNEL:CODE_SEARCH -->
