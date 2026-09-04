# Configuration

The configuration loader applies values in this order:

1. Built-in defaults.
2. Global configuration: `~/.pi/agent/config.toml` (or the configured Pi home).
3. Project configuration: the nearest `config.toml`, `agent-kernel/config.toml`,
   or `.pi/config.toml` while walking upward from the workspace.
4. Environment-variable overrides supported by the loader.

The repository-root `config.toml` is ignored so local settings are not committed.

## Main sections

### `[retrieval]`

- `default_profile`: `lean`, `hybrid`, or `full`.
- `repo_map_budget`: token budget for the repository map.
- `max_search_results`: result limit for code search.

### `[safety]`

- `enable_epistemic_guard`: require inspection before editing existing files.
- `max_line_length`, `max_lines`, and `max_total_bytes`: output-clamping limits.
- `exec_timeout_ms`: bounded subprocess timeout.
- `dedup_min_bytes`: minimum rendered byte size for tool output deduplication side storage.
- `dedup_max_entries_per_session`: maximum LRU capacity for deduplicated tool results per session.

### `[lsp]`

- `idle_timeout_ms`: idle language-server shutdown delay.
- `diagnostic_timeout_ms`: timeout for diagnostic publishing and pull requests.
- `init_timeout_ms`: cold-start LSP initialization timeout.
- `spinner_interval_ms`: LSP modal spinner interval.
- `disabled_servers`: language identifiers to disable.

### `[ui]`

- `enable_pastel_footer`: enable the TrueColor footer when supported.

Invalid or unreadable configuration is handled as a best-effort load failure;
the loader retains defaults rather than presenting an uncertain value as a
successful override.
