# Configuration

The configuration loader applies values in this order:

1. Built-in defaults.
2. Global configuration: `~/.pi/agent/config.toml` (or the configured Pi home).
3. Project configuration: the nearest `.pi/config.toml`, `config.toml`,
   or `agent-kernel/config.toml` while walking upward from the workspace.
4. Environment-variable overrides supported by the loader.

The repository-root `config.toml` is ignored so local settings are not committed.
See `config.example.toml` in the repository root for a documented configuration template.

## Managing Settings

Settings can be managed via the `/agent-kernel` interactive modal or CLI subcommands:
- `/agent-kernel` opens an interactive TUI to view and toggle settings across project and global scopes.
- Modifications made in the modal are buffered in-memory while navigating and applied in a single atomic batch on modal close (`Esc` / `q`), preventing intermediate re-indexing runs.
- CLI subcommands: `/agent-kernel status`, `/agent-kernel set <key> <val> [--global]`, `/agent-kernel reset [--global]`.

## Main sections

### `[retrieval]`

- `default_profile`: `auto`, `lean`, `hybrid`, `full`, or `off`.
- `max_search_results`: result limit for code search.

### `[safety]`

- `enable_epistemic_guard`: require inspection before editing existing files.
- `max_line_length`, `max_lines`, and `max_total_bytes`: output-clamping limits.
- `exec_timeout_ms`: bounded subprocess timeout.

### `[editing]`

- `mode`: `"smart_anchor"` (default) or `"standard"`.
- `default_anchors`: boolean (`true` by default) rendering contextual line hashes on targeted reads.
- `read_mode`: `"auto"` (default), `"plain"`, or `"anchored"`.
- `syntax_gate`: `"warn"` (default in smart anchor mode) or `"block"` (blocks invalid syntax before write).

### `[ui]`

- `enable_pastel_footer`: enable the TrueColor footer when supported.

### `[instructions]`

- `enabled`: inject Agent Kernel guidance into the system prompt (default: `true`).
- `pi_docs`: toggle inclusion of Pi documentation reference guidance in the system prompt (default: `true`).

Invalid or unreadable configuration is handled as a best-effort load failure;
the loader retains defaults rather than presenting an uncertain value as a
successful override.
