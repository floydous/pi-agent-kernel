# Changelog

## [0.4.0] - 2026-09-23

### Added
- **.gitignore-Aware Workspace Traversal**: Added unified workspace walker (`src/retrieval/workspace_walker.ts`) shared across `search_chunker`, `repomap`, and `ast_search`. Evaluates hierarchical `.gitignore` files leaf-to-root with directory pruning (`dir/`), wildcard descent (`dir/*`), child negation overrides (`!keep.ts`), and additive `.piignore` support.
- **Transactional Incremental Vector Updates**: Added `updateFile()` to `HybridSearchIndex` to re-chunk only modified files on mutation and reuse cached 768d vectors by content hash across line shifts and untouched functions.
- **Generational Protection & Query-Time Freshness**: Protected in-flight file updates with generation counters to cancel superseded jobs, and made `search()` await active updates for strict snapshot freshness.
- **Debounced Disk Persistence**: Implemented `scheduleDebouncedSave()` and `flushPendingSave()` to coalesce rapid sequential mutations into debounced atomic writes and guarantee persistence on session shutdown.
- **Direct Ignore Dependency**: Added `"ignore": "^7.0.5"` as an explicit dependency for standards-compliant pattern matching.
- **Reference Configuration Template**: Added `config.example.toml` as a clean, documented template for project (`.pi/config.toml`) and global (`~/.pi/agent/config.toml`) settings.
- **Test Suites**: Added comprehensive regression suites for security hardening (`tests/security-hardening/`), Windows deep verification (`tests/windows-deep-verification.ts`), incremental updates (`tests/retrieval/incremental_update.test.ts`), and gitignore traversal parity (`tests/retrieval/gitignore_traversal.test.ts`).

### Changed
- **Profile Scope Expansion**: Fully aligned configuration types, TUI selectors, and CLI subcommands to support `auto` (adaptive VPS/desktop profile) and `off` (completely disabled retrieval) alongside `lean`, `hybrid`, and `full`.
- **Decoupled Snapshot Invalidation**: Ignore configuration hashes (`.gitignore`, `.piignore`) are tracked in dedicated snapshot metadata (`ignoreConfigHashes`) rather than indexed code file tables, automatically purging newly-ignored files on the next search without reporting phantom files.
- **Live Retrieval Configuration Sync**: Unified `/engine`, `SearchControlModal`, and `/agent-kernel` commands to reconfigure running `HybridSearchIndex` instances and refresh statusline/footer badges immediately upon profile change without requiring session reloads.
- **Hierarchical Config Scoping**: Enforced strict configuration isolation where project-level changes write strictly to local `.pi/config.toml`, following the hierarchy: Project TOML > Global TOML > Legacy JSON > Lean defaults.
- **Index Mutation Purity**: Removed silent disk-write side effects from `HybridSearchIndex.setProfile()`.

### Fixed
- **Retrieval Index Pollution**: Search chunking respects `.gitignore` rules and hard exclusions (`agent-kernel-benchmark/cache/`, `.git/`, `node_modules/`), preventing third-party benchmark fixtures from polluting workspace search indexes.
- **Symlink & Path Containment**: Traversal skips symbolic links and confirms canonical paths remain bounded inside the workspace root.
- **Windows Path & Line Ending Resilience**: Preserved CRLF line endings during smart anchor edits and syntax verification without introducing mixed newlines. Normalized relative display paths to POSIX forward slashes in `read`, `edit`, and LSP formatters.
- **NTFS Case-Insensitive Collisions**: Prevented duplicate target path collisions in multi-file edits on case-insensitive filesystems. Handled case-insensitive path comparisons in LSP references and AST symbol search.
- **PowerShell Clamping & Windows Executables**: Intercepted and clamped `powershell` tool output in `tool_result` hooks alongside `bash`, and recognized `.cmd`, `.bat`, and `.exe` extensions in epistemic guard inspection.
- **LSP Installer Discovery**: Required confirmed executable presence on disk before reporting successful LSP server installation.
- **Config Tracking Removal**: Untracked root `config.toml` from Git and removed it from package distribution. Default configurations run purely in-memory, while user overrides persist cleanly to `.pi/config.toml` (workspace, gitignored) or `~/.pi/agent/config.toml` (global).
- **Deferred Settings Application in `/agent-kernel` TUI**: Cycling through setting options (e.g. `lean` -> `hybrid` -> `full`) no longer writes intermediate states to disk or triggers intermediate re-indexing runs. Changes are buffered in-memory and applied in a single atomic batch only when the user closes the modal (`Esc` / `q`).
- **In-Flight Re-indexing Cancellation on Profile Switch**: Fixed a race condition where switching retrieval profiles while background indexing was active (e.g. `hybrid` -> `full`) continued running the superseded profile's embedding loop and overwrote the statusline with the old profile tag. In-flight sync jobs are now cleanly aborted via generation tokens and abort controllers, and the statusline immediately tracks the newly active profile.

### Security
- **TOML Prototype Pollution Hardening**: Hardened `parseToml` and `mergeDeep` using null-prototype dictionaries and explicit rejection of dangerous keys (`__proto__`, `constructor`, `prototype`).
- **Safe Executable Discovery**: Replaced shell-spawning executable resolution with direct filesystem PATH/PATHEXT scanning and `execFileSync`.
- **LSP Stdio Framing Guard**: Enforced strict `Content-Length` boundary checks, exact decimal matching, and stream resynchronization recovery against malformed headers and buffer overflows.
- **Bounded Session Repair**: Added bounded session repair log scanning with atomic writes and filtered out symlinks during temporary spillover log cleanup in `/tmp`.

### Removed
- **Legacy `/profile` Command & `codebase_profile`**: Completely removed the redundant `/profile` slash command (`auto`, `light`, `heavy`, `status`), `codebaseProfileBySession` tracking map, and unused repo-map scale injection code in `before_agent_start`.
- **Codebase Scale Settings**: Removed `codebase_profile` from `RetrievalConfig`, TOML defaults, environment variables (`PI_CODEBASE_PROFILE`), `/agent-kernel` CLI (`set codebase`), and the TUI settings modal. Code retrieval configuration is now unified exclusively under `/engine` and `/agent-kernel`.

## [0.3.31] - 2026-09-22

### Added
- **Unified `/agent-kernel` Settings**: Added interactive modal and CLI commands (`status`, `set`, `reset`) for managing extension settings across workspace (`.pi/config.toml`) and global (`~/.pi/agent/config.toml`) scopes.
- **Spillover Hardening**: Enforced restrictive `0o600` permissions on temporary command output logs in `/tmp` with automated 20-file bounded rotation.

### Changed
- Removed repository-level `AGENTS.md` from git tracking.

## [0.3.3] - 2026-09-20

### Added
- **Multi-File Atomic Edits**: Extended the `edit` tool with `files: { path, search, replace, line_hint, edits }[]` payload (with resilient per-item `path` normalization in `edits`). Implemented a 2-stage atomic commit with preflight validation, duplicate path detection, in-memory snapshot backups, and automatic rollback across all targets if any file fails patch application or syntax verification.
- **Batch Multi-File `read`**: Extended the `read` tool to accept `paths: string[]` (and resilient alias `path: string[]`), allowing the model to inspect multiple files in one turn while authorizing all targets in `EpistemicGuard`.
- **Automatic Turn 1 Reproduction Diff Grounding**: In `before_agent_start`, automatically detects unstaged/staged git diffs and injects a sanitized, clamped (max 25 lines, 2KB hard ceiling) reproduction status into initial context with session caching, eliminating redundant Turn 1 exploratory `git status` / `git diff` commands.

### Changed
- **Read Tool Budgeting & Anchor Guardrails**: Bounded batch reading to 150 lines per file and a 24KB aggregate ceiling with explicit continuation markers (`[truncated: <file>, returned lines 1-150 of <N>. Continue with read(path, offset=151)]`). Added a 100-line cap on explicit `anchors: true` requests (`MAX_ANCHOR_LINES = 100`) to prevent models from generating expensive `#HASH│` line hashes on large files.
- **Targeted Reading Workflow Guidance**: Updated `AGENT_KERNEL_SYS_PROMPT.md` to emphasize targeted sequential reads (`read(path, offset, limit)`) centered on search coordinates as the primary inspection workflow, reserving batch `paths` for short files or known regions.
- **Search Specificity Guidance**: Directed agents toward exact identifiers, error symbols, and test phrases, preventing noisy broad single-word searches from polluting conversation context.

### Validated
- Verified 38 test suites passing (`npm test`) with 0 regressions.
- Multi-harness benchmarks on `cx/gpt-5.6-luna:high` across all 8 standard tasks demonstrate:
  - **100% Solve Rate (8 / 8 tasks solved)**.
  - **Aggregate task time cut in half**: **600s (10.0m) vs 1,223s (20.4m)** (-50.9% time reduction, **2.04× faster**).
  - **Uncached input tokens reduced by -18.4%**: **270k vs 331k** (-60.8k tokens saved across the suite).
  - **Tool calls reduced**: **107 calls vs 112 calls**.
  - Consistent speedup across all repositories: UFO (36s vs 119s), Fastify (47s vs 177s), p-limit (60s vs 176s), Ky (89s vs 253s), Zod (135s vs 212s), Hono (64s vs 96s), UUID (53s vs 64s), and Picomatch (116s vs 126s).

## [0.3.2] - 2026-09-16

### Added
- **Statusline Retrieval Indicator & Extension Row Integration**: Relocated the retrieval profile tag from Line 1 to Line 2 (extension statusline via `ctx.ui.setStatus("retrieval", ...)`) alongside external extensions (such as Ponytail), preserving individual extension ANSI colors.
- **Profile Semantic Glyphs**: Added distinct visual tier glyphs: `🌿 retrieval:bm25` (AST lexical), `◈ retrieval:hybrid-256d` (Matryoshka hybrid), and `🧠 retrieval:dense-768d` (Full semantic).
- **Live Embedding Throughput & Stream Arrow Status**: Added real-time chunk processing throughput (`chunk/s`) with a static Stream Arrow indicator during workspace indexing (`🧠 retrieval:dense-768d ⇢ 45% (22/48 • 14.2 chunk/s)`).
- **Automatic Kernel Guidance Injection**: Bundled `AGENT_KERNEL_SYS_PROMPT.md` is injected through Pi's `before_agent_start` lifecycle hook, enabled by default and configurable with `[instructions] enabled = false`.
- **Benchmark Comparison Chart**: Added the latest aggregate harness comparison graphic at `static/benchmark-comparison.png` for display in the project README.
- **Six-Harness Cross-Agent Benchmark**: Integrated comprehensive multi-harness comparison runner supporting Pi Kernel, Pi Vanilla, Claude Code, Codex CLI, OMP, and OpenCode across 8 real-world tasks.
- **Passive Shield Architecture**: Gated exploratory tools (`ast_search`, `get_repo_map`, `lsp`) behind `enable_tools: false` / `PI_ENABLE_ALL_RETRIEVAL_TOOLS=1`, keeping the active tool interface lean (`read`, `edit`, `write`, `bash`, and compact `code_search`) to eliminate per-turn schema overhead and tool distraction loops.
- **Deterministic Delimiter Auto-Healing**: Added patch-scoped lexical delimiter balancing and Tree-sitter AST repair (`MISSING` node detection) to automatically recover truncated closing braces/brackets (`})`, `};`, `]}`) pre-write.
- **Line-Hinted Range Disambiguation & Multi-Block Line Deltas**: Added optional `line_hint`, `start_line`, and `end_line` parameters (supporting both camelCase and snake_case) to `edit` with sequential delta tracking to disambiguate identical search blocks without line-hash bloat.
- **Capped Plain-Text Reads**: Enforced 50KB / 2,000-line caps on broad reads with continuation hints (`offset`) and oversized line detection, recording precise exposure ranges in `EpistemicGuard`.
- **Model Property Aliasing & Epistemic Confirmation**: Supported model convention drift across parameter names (`search`/`replace`, `old`/`new`, `old_text`/`new_text`) and emitted concise positive confirmation strings (`Successfully applied edit to <file>.`) to prevent paranoid agent verification loops.

### Changed
- Included `AGENT_KERNEL_SYS_PROMPT.md` in the published package so automatic guidance works after installation.
- Added lifecycle coverage for guidance injection, duplicate prevention, and the disabled configuration path.
- **Tool Description Optimization**: Completely redesigned tool descriptions for `read` and `edit` to explicitly declare clean plain-text defaults and precision parameter expectations, dropping 10k+ prompt inflation tokens on real benchmarks.
- **Performance**: Cut 8-task benchmark token consumption from **1,214,112 tokens down to 465,139 tokens (-61.7%)**, outperforming stock Pi Vanilla (579,088 tokens, -19.7% overall) across 8 real-world repositories.
- **Persistent Vector Profiles**: Preserved dimension-specific binary caches (`vectors-256d.bin`, `vectors-768d.bin`) on disk across profile switches, preventing cache loss when toggling to BM25.
- **On-Demand Embedder Loading**: Removed premature model preloading on startup; weights load on-demand only when unindexed chunks are detected.

### Fixed
- **Startup Background Indexing Visibility**: Fixed a bug where workspace indexing on `session_start` ran silently in the background without updating the UI statusline on cold or unindexed workspaces.
- **Companion Symbol Token Inflation**: Deduplicated companion symbols and clamped surrounding context lines during targeted symbol reads to eliminate token bloat.

### Removed
- Removed the obsolete `AGENT_KERNEL_PROPMPTS.md` prompt document.
