# pi-agent-kernel

![Comparison Demonstration](https://raw.githubusercontent.com/floydous/pi-agent-kernel/master/static/comparison.gif)

Coding agents waste tokens when they read entire files for single functions, dump thousands of lines of terminal output into the context window, or rewrite complete files for one-line edits. `pi-agent-kernel` is an extension for Pi that reduces token usage through scoped reads, bounded command outputs, and syntax-checked edits.

---

## Token savings

How tool overhead compares to an unconstrained agent harness across standard coding tasks:

| Interaction | Standard agent harness | pi-agent-kernel (Passive Shield) | Tokens saved | Why |
|---|---|---|---|---|
| Whole benchmark suite (8 tasks) | Pi Vanilla baseline (1.54M tokens) | Pi + Agent-Kernel (762k tokens) | -50.6% | Cuts per-turn schema tax, stops exploratory loops, and applies surgical edits. |
| Monorepo navigation (Zod, 140k+ LOC) | Directory listings and full file dumps (104k tokens) | Plain reads and AST symbol queries (50.5k tokens) | -51.5% | Caps reads at 50 KB / 2,000 lines and extracts symbols directly without line hashes. |
| Patching and delimiter repair | Failed edits caused by token cutoffs (16.7% failure rate) | Tree-sitter and lexical repair (`edit`) | Auto-heals truncated delimiters | Recovers missing closing brackets pre-write when AST validation passes. |
| Running tests and builds | Terminal logs dumped into context (~20k+ tokens) | Clamped output with disk spillover (~1.0k tokens) | ~95% context saved | Writes full output to disk and shows only the head, tail, and log path. |
| Function inspection | Full file reads with line hashes (~4.0k tokens) | Plain text reads or symbol extraction (~420 tokens) | ~70–90% | Defaults to plain text with targeted AST symbol reads. |

---

## Benchmarks

Evaluating 6 coding agent harnesses across 8 real-world bug fixes (`hono`, `ky`, `zod`, `ufo`, `picomatch`, `fastify`, `uuid`, `p-limit`) on `cx/gpt-5.6-luna:high`:

| Harness | Solved | Success | Time | Input Tokens | Output Tokens | Total Turn Tokens | Tool Calls |
|---|:---:|:---:|---:|---:|---:|---:|:---:|
| Pi + Agent-Kernel | 8 / 8 | 100% | 10m 00s | 270k | 13.5k | 861k | 107 |
| Pi (Vanilla) | 8 / 8 | 100% | 20m 24s | 709k | 32.3k | 1.54M | 149 |
| Codex CLI | 8 / 8 | 100% | 20m 28s | 3.24M | 40.1k | 3.28M | 102 |
| OpenCode | 8 / 8 | 100% | 25m 57s | 1.42M | 23.0k | 3.61M | 229 |
| OMP | 7 / 8 | 87.5% | 19m 24s | 906k | 29.8k | 4.16M | 384 |
| Claude Code | 6 / 8 | 75.0% | 36m 00s | 4.39M | 85.8k | 4.48M | 183 |

![Benchmark Comparison](static/benchmark-comparison.png)

*Prompts describe symptoms and expected behavior without providing the fix. Token totals reflect each tool's reported telemetry. In Claude Code, 1 additional task passed test verification after timing out.*

---

## Quick start

### 1. Install

Install the extension through Pi's package manager:

```bash
# Global install
pi install npm:@floydous/pi-agent-kernel

# Local install for the current workspace only
pi install -l npm:@floydous/pi-agent-kernel
```

Restart Pi or start a new session. The extension registers its tools, guards, status indicators, and workflow guidance automatically.

The compact instructions in `AGENT_KERNEL_SYS_PROMPT.md` are appended to the agent system prompt via Pi's `before_agent_start` hook. You can disable this by setting `[instructions] enabled = false` in `config.toml`.

---

### 2. Configure the retrieval engine (`/engine`)

`pi-agent-kernel` includes an in-memory retrieval engine for keyword and vector search, shown on the extension status line:

```text
/engine status
```

- `lean` (default): `🌿 retrieval:bm25` (AST-indexed BM25 keyword search, 0 MB model RAM)
- `hybrid`: `◈ retrieval:hybrid-256d` (BM25 keyword search plus local 256-dimension Matryoshka embeddings)
- `full`: `🧠 retrieval:dense-768d` (Dense 768-dimension semantic embeddings for conceptual queries)
- `off`: Disables local indexing for users who only want AST and LSP tools

During indexing, the status line shows chunk throughput and progress:
```text
🧠 retrieval:dense-768d ⇢ 45% (22/48 • 14.2 chunk/s) • ○ 🐴 ponytail: ⚡ FULL
```

Switch profiles directly:
```text
/engine hybrid
# or
/engine full
```

---

### 3. Codebase scale profiles (`/profile`)

The extension adjusts prompt context based on repository size. On small codebases (<10 implementation files, <50 KB code), the 1,024-token PageRank map is omitted to save tokens. On larger projects, it is included automatically.

Check or change the profile:
```text
/profile status     # Check current profile and detected codebase metrics
/profile light      # Suppress automatic repo map
/profile heavy      # Always inject PageRank repo map
/profile auto       # Auto-detect based on codebase volume (default)
```

Or set the environment variable:
```bash
export PI_CODEBASE_PROFILE=light   # "heavy", "auto", or "smart"
```

---

### 4. Language server setup (`/lsp`)

Inspect compiler diagnostics, jump to definitions, and find references:

```text
/lsp
```

Running `/lsp` displays detected languages, connection states, and installation options for language servers.

To install a language server directly:
```text
/lsp install <language>    # e.g. python, typescript, rust, go, csharp
```

---

### 5. Unified settings & configuration (`/agent-kernel`)

Manage all Agent Kernel settings interactively or from the command line:

```text
/agent-kernel
```

- **Interactive TUI Modal**: Mirrors native Pi component layouts (`/thinking` and `/settings`) with 4 categorized domains (`Retrieval & Exploration`, `Safety & Verification`, `Editing Engine`, `System Guidance & UI`).
- **Interactive Search**: Type to filter across setting IDs, labels, categories, and descriptions in real time.
- **Dynamic Descriptions**: Updates in real time to explain the active option value.
- **Global Scope Toggle (`G`)**: Press `G` (or `Ctrl+G`) on any setting to toggle applying it globally (`~/.pi/agent/config.toml`) vs. workspace-local (`.pi/config.toml`). Global settings are highlighted in **yellow**.
- **Tab Navigation**: Jump between categories with `Tab` / `Shift+Tab`.

Headless CLI commands:
```text
/agent-kernel status             # Print current configuration and file paths
/agent-kernel set <key> <val>    # Update a specific setting globally
/agent-kernel reset              # Reset global configuration to defaults
```

---

### 6. Disable Pi documentation for external projects

Pi loads instructions for developing Pi extensions, skills, and themes by default. When working on standard application code, you can disable those instructions to free up prompt space:

```text
/pi-docs off
```

Use `/pi-docs on` when returning to work on Pi extensions.

---

## Tool reference

| Tool | What it does |
|---|---|
| `read` | Reads plain text with 50 KB / 2,000-line safety caps, or extracts a function, class, or type via AST (`symbol="name"`). |
| `edit` | Applies search and replace patches with automatic delimiter healing and optional `line_hint` disambiguation. |
| `write` | Creates new files or rewrites existing files when needed. |
| `bash` | Runs shell commands (`rg`, `git status`, test runners) with clamped outputs and spillover logs on disk. |
| `code_search` | Hybrid AST BM25 and semantic chunk search with breadcrumb locations for conceptual discovery. |

*Note: Exploratory tools (`ast_search`, `get_repo_map`, `lsp`) are gated behind `PI_ENABLE_ALL_RETRIEVAL_TOOLS=1` pending redesign in v0.4.0.*

---

## License

ISC
