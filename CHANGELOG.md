# Changelog

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
