# Changelog

## [Unreleased]

### Added

- **Line Span Confirmation in `edit`**: Successful edits now report the affected 1-based line span (e.g. `lines 14–18 -> 14–16`, `line 10 -> line 10`, or `lines 20–22 deleted`) directly in the confirmation text. This gives agents immediate proof of the edit's exact location and resulting line numbers without burning turns on redundant post-edit `read` calls.

- **HTML Code Is Now Searchable**: Code search now indexes `.html` and `.htm` files using the bundled `tree-sitter-html.wasm` (v0.23.2). Semantic DOM landmarks (`main`, `nav`, `section`, `article`, `header`, `footer`, `form`, and interactive panels) are chunked into coherent groups (<= 70 lines), while interactive leaf controls (`input`, `button`, `select`) roll up into their parent forms or panels instead of cluttering search results with single-line snippets. Inline `<style>` and `<script>` boundaries are enforced so raw CSS rules and script bodies do not leak into template chunks. Within the source tier, executable code files rank ahead of HTML templates.
- **Stream Large Spillover Logs and Data Files in `read`**: The `read` tool now streams line windows directly from disk for authenticated shell spillover files (`pi_bash_spillover_*.log` and host harness logs) and windowed file reads (`offset` or `limit` specified) up to 50 MB. Using a 64 KB chunk buffer and `StringDecoder`, seeking to any line range operates in $O(1)$ memory (< 200 KB heap) and exits early once the 50 KB output budget is met. Spillover files read without line arguments default to lines 1–250 with continuation instructions. Unconstrained reads on regular workspace source files exceeding 5 MB continue to fail closed to prevent accidental context blowups.

- **Fullwidth Dot Normalization**: Edits now convert the fullwidth full stop `．` (U+FF0E) to a regular `.` in search, replacement, and anchored line text, so models that emit fullwidth dots no longer produce broken code or failed matches. Enabled by default; turn it off with `/agent-kernel set normalize_dots off`, the settings dashboard, or `editing.normalize_fullwidth_dots = false`.
- **Notice When the Index Leaves Files Out**: When a workspace has more files than the code search index can hold, code search now starts its answer with one line saying how many files the index covers, how many source, test, and vendored files it left out and in which folders, and that `rg` still finds text in them. Workspaces that fit in the index see no change in output.
- **Syntax Check for More Languages**: Edits to Rust, Go, C, C++, Java, C#, Ruby, PHP, and Bash files are now checked with the bundled tree-sitter grammars; before, they were not checked at all. An error is reported only when the original file parsed without errors, so code the grammar does not understand never triggers a warning. On Rust, the check caught 739 of 804 broken edits and raised a false alarm on 1 of 473 valid ones in our tests; the other languages were not measured.

### Changed

- **Evidence-Driven Navigation Guidance**: System prompt guidance in `AGENT_KERNEL_SYS_PROMPT.md` now explicitly directs tool selection based on verified evidence: call `code_search` first when the implementation location of a feature or concept is unverified, use `rg -n` for known code symbols, literal strings, and non-code file types (CSS, JSON, YAML, Markdown), and use targeted `read` ranges before editing.

- **Faster Search Startup in Reopened Workspaces**: The code search index now reuses saved results for files that have not changed instead of re-parsing every file at startup, and updating or removing a file no longer rescans the whole index. Re-syncing an unchanged 500-file repository dropped from about 2.6 s to 0.7 s in our measurements, with identical search results.
- **Faster Code Search Queries**: Before each search, the index now re-reads only files whose size or modification time changed, and reuses its list of workspace files until a folder or ignore file changes, instead of re-reading every file and walking the whole workspace. A search on a 500-file repository dropped from about 340 ms to 20 ms in our measurements. A change that leaves modification times untouched (tools that restore them, some network filesystems) is picked up at the next change or re-index.
- **Search Puts Source Code First**: Code search now returns the best source matches first and lists up to three test matches after them, so tests that describe behavior in plain words no longer push the implementing code out of the results. Searches whose query or file filter mentions tests or specs keep the mixed ranking. On held-out fixes from TypeScript and JavaScript projects, the right file ranked first in 18 of 43 searches, up from 10. A result can therefore hold up to three matches more than its limit (eight instead of five with the default limit); the median result grew by 6–28% in our tests.
- **Rust Tests No Longer Crowd Out Source Code**: Rust unit tests that live inside source files (`#[test]` functions and `#[cfg(test)]` modules) are now treated as tests, so code search lists them after the source matches instead of in their place. In our tests on four Rust repositories, inline test code no longer took any of the top source results; before, it had taken 18 of 152.
- **Large Workspaces Index Their Own Code First**: When a workspace has more than 500 indexable files, the code search index now takes the project's source files first, then tests, then vendored code (folders named `deps`, `third_party`, `external`, and similar), instead of whichever files the folder listing returned first. In redis, whose `deps/` folder used to fill the whole index, the right file now appears in the top five results for 16 of 20 past fixes, up from 0. In four other large C projects (libgit2, git, neovim, curl) it did so for 16 of 48 fixes, up from 15. Workspaces with 500 or fewer indexable files are indexed exactly as before. On very large workspaces each search does more bookkeeping: about 90 ms more per search on a 20,000-file tree in our measurements.
- **Search Answers Show More of the Matching Code**: Code search now previews the top five matches instead of three, and shows a previewed match of up to 2,000 characters in full instead of a 12-line excerpt that often missed the relevant lines. On 168 recorded searches, the answer showed the lines a real fix changed in 72 searches instead of 47 (25 better, none worse). Answers grew by a median of about 400–500 tokens and still stay within the output limit.
- **Better Code Embeddings for the `full` Profile; `hybrid` Merged into `full`**: The `full` profile now embeds code with `Alibaba-NLP/gte-modernbert-base` (Apache-2.0, ~147 MB download on first use) instead of `nomic-embed-text-v1.5`. On 104 held-out searches (fixes from TypeScript and JavaScript projects plus recorded agent queries), the right file appeared in the top five results for 85 searches instead of 66, and the right code chunk for 73 instead of 32; with the old model, `full` found fewer right files and chunks than the default `lean` profile (82 and 67). Across 168 searches in Rust, C, C++, Python, TypeScript, and JavaScript projects, `full` now finds the right file for 125 searches against 114 for `lean`, and the right chunk for 103 against 92; this lead over `lean` is not yet statistically significant, so `lean` stays the default. Indexing a 765-chunk project took 15% less time and about 460 MB less memory than before; each search takes about 20 ms longer (40 ms median). The new model has no smaller-vector mode, so the separate `hybrid` profile is gone: `hybrid` still works as an alias for `full`, and `auto` now picks `full` on machines with 4 or more CPU cores (previously `hybrid` on 4–7 cores, which indexed on one core instead of two). The minimum similarity for a vector match was recalibrated from 0.55 to 0.45 for the new model. Saved vector caches now record which model produced them, so existing vectors are re-embedded once after upgrading.
- **One Search Cache Rebuild After Upgrading**: The Rust test, alias, C++, and C/C++ type-reference changes in this release change how code is indexed, so existing search caches are rebuilt once after upgrading.
- **Faster Syntax Check for Edits**: Each edit is now checked once instead of twice, and TypeScript, TSX, and JSX edits that tree-sitter parses without errors no longer start `tsc`. Anything tree-sitter flags, or a file it cannot fully parse, is still decided by `tsc`, because the grammar lags the language. In our measurements a valid TypeScript edit took about 2 ms to check instead of about 340 ms, with the same verdicts as `tsc` on 1,776 test edits. The temporary copy used for checking is now written to the system temp folder instead of a `.pi-agent-kernel-validate-*` folder next to the edited file.

### Fixed

- **Clean Block Deletion Without Phantom Blank Lines**: Deleting whole-line blocks of code with `replace: ""` across exact, whitespace-normalized, and fuzzy strategies now cleanly consumes surrounding line breaks, preventing phantom blank lines from remaining in the file. Inline substring deletions within a single line leave surrounding lines intact, and `replace: null` is normalized to `""`.
- **Command Output Spillover Files Larger Than 5 MB Can Now Be Read**: When a command output exceeded 5 MB, output clamping stored the full output in a spillover log and suggested inspecting it with `read({ path, offset, limit })`, but `read` rejected the file because it exceeded the 5 MB in-memory read limit. Authenticated spillover logs can now be read and paged through regardless of whether they exceed 5 MB (up to 50 MB).
- **Spillover Deduplication and Collision Prevention**: When a command failed, timed out, or formatted sizes with decimals (`50.0KB`), trailing status notices (`Command exited with code N`, `Command timed out after N seconds`) prevented Agent Kernel from detecting the host's existing spillover log. Agent Kernel would save the already-truncated fragment into a second spillover file, permanently losing the initial output lines and generating desynchronized line coordinates. Host truncation footers, alternative inverted formats (`[Full output: <path> ...]`), decimal line sizes, and trailing status lines are now reliably detected, preserving the host log as the single source of truth without writing redundant partial files. Re-clamping previously clamped outputs with inspection recipes is now idempotent and avoids stacked truncation footers.

- **No Phantom Symbols from Exported Code**: Code search no longer indexes fake alias symbols built from `x as y` text inside exported functions, classes, and constants (for example, `value as unknown` produced a symbol named `unknown`). Real `import { a as b }` and `export { a as b }` aliases are still indexed.
- **C++ Code Is Now Searchable**: Code search now indexes `.cc`, `.cxx`, `.hh`, and `.hxx` files, which it previously skipped entirely, and parses `.h` headers as C++ when they contain C++ code, so classes and methods in them become searchable. In our tests on four C++ repositories, the right file appeared in the top five results for 11 of 14 fixes made in `.cc` files, up from 1. Plain C headers are parsed exactly as before.
- **Visible Notice When Code Parsing Is Unavailable**: If a tree-sitter grammar cannot be loaded, code search now says so at the top of its results instead of silently falling back to a simpler parser for those files. The `web-tree-sitter` dependency is pinned to the version the bundled grammars were tested with, so installs no longer pick up untested runtime versions.
- **C and C++ Type References Are No Longer Indexed as Definitions**: Code search no longer records `struct` and `class` type references and forward declarations without a body (for example, `struct node *next;`) as type definitions. They added one-line junk results and duplicate entries that skewed keyword-ranking statistics. In our tests on 32 repositories, this removed 9,780 such entries (tmux went from 6,097 to 2,922) and all 152 duplicates; Python, Rust, TypeScript, and JavaScript indexes are unchanged. On 88 recent C fixes, results changed for 8 searches: the right file entered the top five in 2 and dropped out in 1, and the right code dropped out in 3, because keyword-ranking statistics shifted (not statistically significant).
- **Empty Search Results Name the File Filter When It Is the Cause**: When a code search file filter matches no indexed file (for example `README`, because Markdown and configuration files are not indexed), the answer now says so and points to `rg`, instead of reporting no matching code and suggesting broader search terms. Searches whose filter matches indexed code keep the previous message.
- **Code Search Works in Workspaces with Very Many Code Chunks**: In a workspace with more than 10,000 code chunks (functions, classes, and similar), every code search failed with "Workspace changed repeatedly while indexing". Searches now succeed: files that do not fit are left out of the index and reported as skipped, and the index stays up to date as files change.
- **Clearer Recovery from Tool Mix-Ups**: When an agent sends a shell command to `read` or `edit`, the error now names the `bash` tool and the exact call to make, instead of a generic missing-path error.
- **Edit Errors Name the Actual Mistake**: An edit with a search block but no replacement now explains how to delete the block with `edits: [{ search, replace: "" }]`. Some model routes silently drop an empty top-level `replace`, which previously caused the same failing edit to repeat. An edit sent read-style `offset`/`limit` arguments now points to the `read` tool.
- **Tool Failures Are Marked as Errors**: Failed `edit`, `read`, and `code_search` calls now reach pi as errors. pi marks a result as an error only when the tool throws, so these failures looked like successful results: collapsed in the interface, and sent without an error flag to models whose APIs carry one (Anthropic, Bedrock, Google, and Mistral; OpenAI's APIs have no such flag).
- **JavaScript Syntax Errors in ES Modules Are Caught**: The syntax check missed syntax errors in `.js` files that use `import` or `export` when the project's `package.json` sets no `"type"`, because `node --check` reports such files as valid (Node 24). JavaScript is now checked as an ES module and as CommonJS, and is valid when either parses. In our tests on such a project, the check caught all 727 broken edits instead of 427.

## [0.5.0] - 2026-10-25

### Added

- **Package Entry Points**: Added standard package entry points, making Agent Kernel easier to import from Node.js projects and external tools.
- **Verification Tests**: Added test coverage verifying editing modes and search result ranking behaviors.

### Changed

- **Streamlined System Guidance**: Simplified the extension prompt to focus on tool selection rather than prescribing rigid workflow steps, giving agents freedom to pick the best strategy for each task.
- **Benchmark Chart Updates**: Updated the benchmark comparison chart to show prompt cache reuse and task solve rates across all evaluated coding agents.

### Fixed

- **Consistent Search Ordering**: Ensured search results and indexed code chunks are ordered identically across different platforms and operating systems.
- **Internal Cleanups**: Improved codebase reliability and maintainability by cleaning up internal types, removing obsolete helper functions, and simplifying branching logic.

### Security

- **Session State Validation**: Added stricter validation when restoring saved session files so prior file inspection records cannot be corrupted.
- **Configuration Parsing Safety**: Hardened custom-settings loading against prototype-pollution attacks, preventing malicious configuration files from altering application behavior.

### Removed

- **Symbol Extraction Parameter**: The file reader no longer accepts an optional symbol parameter. It now standardizes on reading selected line ranges, leaving specialized symbol navigation to dedicated language tools.
- **Exploratory Search & Repo Map Engines**: Removed legacy repository mapping and syntax-tree search tools in favor of unified, fast keyword and semantic code search.
- **Language Server Subsystem**: Removed built-in language-server support. Code intelligence and language diagnostics are now deferred to dedicated extensions like pi-lens.

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
