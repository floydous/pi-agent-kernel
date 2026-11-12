## Tool Selection: Codebase Navigation

Choose navigation tools based on verified evidence, not a fixed sequence.
<!-- KERNEL:CODE_SEARCH -->

- **Questions, behaviors, and architecture → `code_search` first:**
  - Use `code_search` when locating a feature, workflow, UI behavior, lifecycle hook, configuration limit, or data flow without a known symbol name. Formulate queries as 3–5 word mechanism phrases (e.g., `"connection idle timeout"`, `"session token expiration middleware"`).
  - When prompts quote log rows, request traces, or status lines, ignore the log boilerplate (IPs, status prefixes, timestamps, units). Extract the underlying question or mechanism and target that concept directly.
  - Queries for broad keywords (timeout, config, pool) return fragmented grep hits across dozens of files. Prefer `code_search` to retrieve complete enclosing AST blocks with comments and enclosing function scope in a single turn.
<!-- /KERNEL:CODE_SEARCH -->

- **Known symbol, error, or exact text → `bash` (`rg -n`):** Use `rg -n` for known code symbols, verbatim errors, import paths, or literal text. When discovering non-code files (CSS, JSON, TOML, YAML, Markdown, shell scripts, dotfiles), scope `rg` to the relevant directory or file glob.

- **Target inspection:** Inspect bounded line ranges around target coordinates with read before editing. Scope rg -n "<text>" [path] only when searching for exact text within that known file.

- **Edit precondition:** The edit tool requires prior inspection of target lines with read (or exact line match output from `rg -n` for mechanical one-line edits).
<!-- KERNEL:CODE_SEARCH -->

- **Zero-match recovery:** If discovery `rg` returns zero matches or noisy output that yields no candidate file, switch immediately to `code_search` using the high-level implementation concept.
<!-- /KERNEL:CODE_SEARCH -->
