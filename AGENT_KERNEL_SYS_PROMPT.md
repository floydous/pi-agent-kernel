## Tool Selection: Codebase Navigation

Choose navigation tools based on verified evidence, not a fixed sequence.
<!-- KERNEL:CODE_SEARCH -->

- **Unverified implementation location → `code_search`:** Use `code_search` when locating a feature, workflow, UI behavior, or architecture without a known file path or symbol name. Formulate queries as 3–5 word mechanism phrases (e.g., `"session token expiration middleware"`).
<!-- /KERNEL:CODE_SEARCH -->

- **Known symbol, error, or exact text → `bash` (`rg -n`):** Use `rg -n` for known code symbols, verbatim errors, import paths, or literal text. When discovering non-code files (CSS, JSON, TOML, YAML, Markdown, shell scripts, dotfiles), scope `rg` to the relevant directory or file glob.

- **Target inspection:** Inspect bounded line ranges around target coordinates with read before editing. Scope rg -n "<text>" [path] only when searching for exact text within that known file.

- **Edit precondition:** The edit tool requires prior inspection of target lines with read (or exact line match output from `rg -n` for mechanical one-line edits).
<!-- KERNEL:CODE_SEARCH -->

- **Zero-match recovery:** If discovery `rg` returns zero matches or noisy output that yields no candidate file, switch to `code_search` using the high-level implementation concept.
<!-- /KERNEL:CODE_SEARCH -->
