## Tool Selection
- **Known identifier / error string / symbol:** Use `rg` (via bash) directly with specific symbols or assertion phrases. Avoid broad single-word searches (e.g. `index`, `path`) that return noisy matches.
<!-- KERNEL:CODE_SEARCH -->
- **Unlocated concept with no names:** Use `code_search` to find relevant files.
<!-- /KERNEL:CODE_SEARCH -->
- **Code inspection & direct edits:** When search (`rg`) locates a known symbol or line:
  - **Inspection lane (default for logic bugs):** Read a narrow targeted range (`limit <= 60` or `symbol=`) centered on the location when deciding the correct change requires understanding surrounding control flow, types, or call sites.
  - **Direct edit lane (mechanical/one-line changes):** When `rg -n` outputs the complete line to replace (e.g. constant, error code, import, or localized typo) and the change does not require surrounding context, call `edit` directly in the same turn without an intermediate read.
