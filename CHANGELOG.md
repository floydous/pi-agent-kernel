# Changelog

## [Unreleased]

### Added

- **Package Entrypoint Manifest Fields**: Added explicit `"main": "./src/index.ts"` and `"types": "./src/index.ts"` to `package.json` to ensure package consumers can resolve the module entrypoint directly alongside the `"pi.extensions"` manifest.
- **Table-Driven Benchmark Method & RRF Test Suite**: Added `tests/editing/benchmark_method_and_rrf_test.ts` to `tests/run-all.ts` (suite 63) to verify table-driven schemas and descriptions for all 5 `PI_EDIT_METHOD` modes, as well as RRF reciprocal rank fusion signal classification across lexical, semantic, hybrid, and zero-score conditions.

### Changed

- **System Prompt Workflow Guidance**: Removed the prescriptive `## Execution Workflow` section from `AGENT_KERNEL_SYS_PROMPT.md` (covering pre-flight grounding, root-cause priority, multi-file edit grouping, and exit guidance), retaining tool-selection guidance for `code_search`, `rg`, inspection, and direct-edit lanes.
- **Benchmark Suite & Chart Reporting**: Evaluated all 6 agent harnesses on `cx/gpt-6-luna-high` (concurrency 4, 360s timeout) across the 8 core bug-fix tasks. Added a `Tasks Solved (N/24)` category to `agent-kernel-benchmark/generate_chart.py` and updated `static/benchmark-comparison.png` alongside `README.md` with matched six-harness evaluation metrics, where Pi Kernel achieved a 100% solve rate across 24 counterbalanced trials (N=3) with 28.9% fewer tokens and 7.4% faster aggregate runtime than Vanilla Pi.

### Fixed

- **Cleaned Unused Imports in Edit & Search Tools**: Removed unused `kernelDebug` and `findSurgicalPatchTargetRange` imports in `src/tools/edit_tool.ts`, and removed unused `loadKernelConfig` and `getGlobalConfigPath` imports in `src/retrieval/search_config.ts`.
- **Removed Unused Variables & Empty Catches**: Removed unused `isGrepOrRg` in `src/safety/epistemic_guard.ts`, removed dead fields (`isSaving`, `hasPendingSave`, `cacheDir`) in `src/retrieval/search_index.ts`, removed in-place `.reverse()` stack mutation in `src/editing/auto_heal.ts`, and routed all silent empty catches through `kernelDebug`.
- **Cross-Platform Deterministic Code-Unit Sorting**: Replaced locale-dependent string sorting in `search_index.ts` and `search_bm25.ts` with explicit code-unit comparators (`compareStrings` / `a < b ? -1 : a > b ? 1 : 0`), preserving deterministic chunk ordering and index reproducibility across machines and ICU runtimes.
- **Replaced Loose Typings & Unsafe Casts**: Enforced typed `Record<string, Record<string, TomlValue>>` in `getGlobalRawConfig`, eliminated unnecessary `as any` casts across `kernel_config.ts`, `search_config.ts`, `patch.ts`, `workspace_walker.ts`, `index.ts`, and `agent_kernel_command.ts`, and replaced global `isNaN` with `Number.isSafeInteger`.
- **Structural Code Polish & Branch Flattening**: Replaced 25+ redundant `else if` returns with linear `if (...) return;` dispatches in `tree_sitter_engine.ts`, replaced 6-deep nested ternaries in `edit_tool.ts` with structured `switch (benchmarkMethod)` blocks, and flattened nested ternaries across `patch.ts`, `search_modal.ts`, `search_bm25.ts`, `repomap.ts`, `read_tool.ts`, and `post_edit_verification.ts`.

### Security

- **Untrusted Inspection State Boundary Defense**: Hardened `epistemic_guard.ts` session persistence against tampered state files by enforcing strict runtime schema validation, bounding entry counts (<= 1,000 files) and string lengths (paths <= 512, provenance <= 128, queries <= 1,024), discarding duplicate keys to prevent weakening prior evidence, preventing search records from manufacturing `complete: true` coverage, and routing file writes through `writeFileSyncAtomic`.
- **TOML Prototype Pollution Hardening**: Added explicit `Object.defineProperty` data property assignment on `Object.create(null)` tables in `src/config/toml.ts` and expanded test suites verifying that `__proto__`, `prototype`, and `constructor` keys cannot pollute `Object.prototype`.

### Removed

- **Exploratory Tools & Legacy Subsystems (`ast_search`, `repomap`)**: Completely purged the exploratory retrieval engines (`src/retrieval/ast_search.ts`, `src/retrieval/repomap.ts`), tool registrations (`src/tools/ast_search_tool.ts`, `src/tools/repo_map_tool.ts`), result formatters (`src/tools/ast_search_formatter.ts`), and the interactive `/repomap` command. Retained active polyglot AST symbol extraction under `src/retrieval/tag_extractor.ts` to power `code_search` chunking and `read(symbol=...)`. Removed dormant `repo_map_*` and `enable_tools` settings from `KernelConfig` and settings dashboard, while safely tolerating legacy configuration keys for backwards compatibility.
- **LSP Subsystem & Background Daemons**: Removed the background Language Server Protocol subsystem (`src/lsp/`), the agent-facing `lsp` tool (`src/tools/lsp_tool.ts`), and the interactive `/lsp` slash command and TUI modal. Synchronous post-edit LSP diagnostic polling and daemon document synchronization were eliminated from `src/tools/edit_tool.ts` and `src/index.ts`. Language intelligence and semantic LSP diagnostics are deferred to dedicated ecosystem extensions (such as `pi-lens`), while `pi-agent-kernel` remains a pure, zero-daemon in-process extension focused on output clamping, epistemic guards, smart anchors, and Tree-Sitter WASM code search. Existing `[lsp]` configuration blocks in user files are sanitized and safely ignored for backwards compatibility without throwing unknown-section errors.

## [0.4.3] - 2026-10-24

### Fixed

- **Syntax Verifier Host Executable Resolution**: Added `resolveNodeExecutable` in `src/editing/syntax-verify.ts` to probe candidate Node runtimes (including Electron environments with `ELECTRON_RUN_AS_NODE=1` and system `PATH` discovery) before running `--check` or `tsc`. Resolves false-alarm `[SYNTAX WARNING]` notices when operating inside packaged host environments where `process.execPath` is not a standard Node CLI.
- **Differentiated Syntax Diagnostics from Operational Crashes**: Syntax verification only classifies results as `failed` when genuine grammar diagnostics (`SyntaxError`, TypeScript core grammar codes `TS1000`–`TS1999`, or JSX codes `TS17000`–`TS17999`) are emitted. Runtime/checker operational faults or missing dependencies fail open gracefully with `status: "unavailable"`.
- **Host Truncation Deduplication**: Extended `HOST_TRUNCATION_REGEX` in `src/safety/output_clamper.ts` to match modern Pi host truncation footers (`[Truncated by host harness. Full: ...]`) with strict line termination, eliminating duplicate stacked notices.

### Added

- **Spillover Recovery Affordances & Omitted Line Ranges**: Middle truncation markers in `output_clamper.ts` now explicitly state the 1-based omitted line span (`[... N lines omitted (lines A–B) ...]`), and spillover footers provide an actionable tool-native `read` recipe (`read({ path, offset, limit })`) when byte budgets permit, allowing agents and developers to retrieve omitted failure regions in a single targeted turn without guessing line coordinates.
- **Actionable Stale-File Drift Diagnostics**: Enhanced `epistemic_guard.ts` stale-file drift rejections to calculate pinpoint read coordinates (`offset` and `limit`) around target edit ranges, enabling agents to re-synchronize in a single narrow read rather than prompting whole-file reads.
- **Ergonomics & Safety Boundary Adversarial Test Suite**: Added `tests/security-hardening/ergonomics_adversarial_test.ts` verifying syntax verification boundaries, search-to-edit boundaries, stale-drift pinpoint recovery, and forged truncation footer defense.

## [0.4.2] - 2026-10-24

### Added

- **Tier 1.5 Verified Search Overlap Authorization**: Authorized direct find-and-replace edits immediately following `rg -n` searches when the target search block uniquely matches on disk and overlaps an observed search hit with bounded context (<= 3 lines before/after), eliminating redundant `read` ceremony turns.
- **Bounded Micro-Hydration for Adjacent Edits**: Edits targeting lines immediately adjacent to a recorded search hit (<= 2 lines away, <= 5 lines total) are verified directly against disk and authorized in the same turn without throwing guard rejections.
- **Durable Session Continuity (`inspection-state.json`)**: Persisted inspected file state across session restarts and resumes under `~/.pi/cache/agent-kernel/sessions/<workspaceId>/<safeSessionId>/inspection-state.json`. SHA-256 content fingerprints and canonical workspace boundaries are revalidated on rehydration, invalidating modified or deleted files fail-closed.
- **Emitted Context Line Parsing & Path Disambiguation**: Hardened `parseGrepOutput` to capture context lines (`-C`, `-A`, `-B` with `path-123-context`) into visible line coverage, strip ANSI escapes, skip `--` separators, reliably parse Windows drive letters (`C:\...`), and disambiguate `-<digits>-` in filenames/directories from context delimiters across Linux and Windows.

### Changed

- **Two-Lane Prompt Guidance**: Updated `AGENT_KERNEL_SYS_PROMPT.md` to introduce a clear distinction between the **Inspection Lane** (reading narrow ranges for complex logic bugs) and the **Direct Edit Lane** (calling `edit` directly after exact `rg -n` output for mechanical replacements).
- **Edit Tool Description**: Clarified in the `edit` tool definition that edits are valid after a read or directly after an exact `rg` search, keeping the schema under the 1,200 character ceiling.

## [0.4.1] - 2026-10-24

### Added

- **Adaptive Diagnostic-Windowed Output Clamping**: Added failure-aware diagnostic windowing for shell outputs exceeding line limits. When execution fails or test runners report structured errors (`FAIL`, `AssertionError:`, `error[E\d+]:`, `TypeError:`, `--> file:line:col`), the clamper pins 4 head lines (command invocation) and 4 tail lines (summary stats) while centering the remaining window directly on the root-cause assertion diff. Clean runs and discovery searches (`rg`, `grep`, `find`, `ls`) strictly retain compact symmetric clamping.
- **Per-Block Hybrid Edit Authorization**: Added independent per-block authorization in `checkReadPrecondition`. Each block in a multi-block edit qualifies if its target range was observed in visible read evidence (Tier 1) OR if it is anchored by a substantive multi-line block (>= 2 non-empty content lines and >= 35 substantive trimmed characters, Tier 2). Eliminates ceremonial whole-file re-reads when editing distant functions and file headers together.
- **Pinpoint Remediation Guidance**: Rejected unanchored single-line edits return exact targeted read coordinates (`read({ path, offset, limit })`) clamped to EOF rather than generic whole-file suggestions, reducing recovery token overhead by over 80%.
- **Dynamic Tool Suggestion Gating**: Dynamically gate companion tool suggestions and diagnostic hints in `read`, `code_search`, and `lsp` so the model is never advised to call unregistered or profile-disabled tools (such as `ast_search` or `lsp` when inactive).
- **Default 250-Line Reading Window**: Enforced a 250-line default window (`DEFAULT_READ_LINES = 250`) on unconstrained broad reads (`read` calls without explicit line counts or offsets) with continuation hints, preventing accidental whole-file context blowups while honoring explicit model limits.
- **Automated Release & Package Immutability Guards**: Added `.github/scripts/npm-version-guard.mjs`, `release-artifact.mjs`, and release workflow CI checks to prevent accidental overwrites, validate tarball dependencies, and enforce semantic version immutability pre-publish.

### Security

- **Repository Diff Injection Prevention**: Removed repository diff injection from the system prompt, trusted project configuration only after explicit project trust, validated all configuration fields, and bounded read/index/LSP output paths.
- **Process & Binary Boundaries**: Excluded workspace executables from LSP resolution, added shell-free child launches with a minimal environment, and pinned language-server installers and the embedding model revision.
- **Cache Isolation & Vector Integrity**: Moved retrieval caches to a trusted per-workspace directory, validated persisted chunks against current source, and verified every persisted vector against its owning chunk's content hash before activation.
- **Hardened Persisted Index Loading**: Paths must be workspace-relative and free of symlinked components, chunk metadata is bounded and schema-checked, and vectors must be finite floats matching the configured dimension.
- **Descriptor-Level File Safety**: Read index, vector, and workspace source files through bounded descriptors with `O_NOFOLLOW` and `fstat` identity checks, rejecting files replaced mid-read.
- **Resource & Spillover Caps**: Enforced strict runtime ceilings on single-file reads (5MB), per-file indexing (2MB), aggregate memory (20MB), and spillover storage (20 files, 50MB) with `0o600` permissions and automated pruning.

### Fixed

- **Kernel Edit/Read Built-in Replacement**: Built-in tool detection previously compared `sourceInfo.path` against the literal `<builtin:`, but pi's actual prefix is `builtin:`. As a result, kernel `read` and `edit` were never registered, deferring to pi's defaults. Built-ins are now identified by `sourceInfo.source === "builtin"`, fully activating smart-anchor healing, atomic multi-file rollback, syntax verification, and CRLF preservation.
- **Atomic Multi-File Rollback & Drift Locking**: Made smart anchors fail closed on stale hashes, serialized file mutations, and ensured multi-file rollback cleanly restores disk, index, LSP, and guard state.
- **Retrieval Cache Incremental Reconciliation**: Reloading the index no longer discards unchanged chunks and vectors. Changed and deleted files are marked stale and removed from search while their hashes are retained for incremental reconciliation, re-embedding only changed files.
- **Stale Vector Reactivation**: Cached vectors belonging to modified or deleted files can no longer be reused, including when a chunk keeps an identical id after the source changes.
- **Multi-Workspace Code Search Availability**: `code_search` registration no longer depends on the first session's retrieval profile. A single extension instance serves multiple workspaces with per-workspace profile gating at execution and in prompts.
- **CRLF Session Repair**: Session repair now preserves each record's original line separator instead of rewriting CRLF sessions to LF.
- **Prompt Guidance CRLF Tolerance**: The guidance marker regex tolerates CRLF checkouts, and the injected prompt omits `code_search` guidance when the retrieval profile is `off`.
- **Host Truncation Deduplication**: Output clamping detects prior truncation footers from host or kernel passes and reuses the existing spillover file rather than creating redundant copies.
- **BM25 Path Matching & Deterministic Ordering**: File removal matches exact path prefixes instead of substring matches, and equal-score results are ordered deterministically by chunk id.

### Changed

- **XML System Prompt Guidance Framing**: Wrapped Agent Kernel guidance inside `<agent_kernel_guidance>...</agent_kernel_guidance>` with idempotent block detection, aligning with Pi core's XML container grammar (`<tools>`, `<rules>`, `<docs>`) and preventing double H2 Markdown header collisions.
- **Strict Multi-Line Context for Unread Tier 2 Anchors**: Removed the single-line `>= 50 chars` loophole from Tier 2 authorization. Unread anchors must be strictly multi-line, and blank-line or whitespace padding cannot inflate the character count.
- **Discovery Tool Isolation**: Wired `isDiscoveryCommand(command)` into output clamping to guarantee search tools (`rg`, `grep`, `find`, `ls`) are never inadvertently treated as diagnostic failure outputs even when matched source text contains error keywords.
- **Topology-Driven Prompt Guidance**: Refined `AGENT_KERNEL_SYS_PROMPT.md` to prioritize targeted sequential reads centered on search coordinates over broad multi-file batches, directing agents to fix root causes rather than symptoms.
- **Code-Only Retrieval Scope**: `code_search` indexes code extensions only; Markdown and other prose extensions were dropped along with the `prose` scope option.
- **Simplified `code_search` Output**: Replaced the mode/count diagnostic header with a plain-language preview notice in mixed mode.
- **Reduced Prompt Markers**: Removed the unused `read`, `edit`, and `bash` guidance blocks; only `code_search` availability varies by profile.
- **Calibrated Clamping Defaults**: Raised the default clamped output to 100 lines and aligned the system prompt to direct root-cause fixes.
- Added `scripts/podman-linux-check.sh`, which runs tracked working-tree snapshots in a disposable Linux container for cross-platform verification.
