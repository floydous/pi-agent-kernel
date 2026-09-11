# pi-agent-kernel

![Comparison Demonstration](https://raw.githubusercontent.com/floydous/pi-agent-kernel/master/static/comparison.gif)

Most coding agents drown in context. They read entire files when looking for a single function, dump thousands of lines of terminal logs into prompts, and rewrite full files just to tweak one line. `pi-agent-kernel` is built around a straightforward rule: **spend the bare minimum tokens necessary to get maximum workflow performance**. It provides surgical retrieval, bounded outputs, and guarded editing tools so your model stays fast, focused, and well within budget.

---

## Token savings

Here is how tool overhead compares to an unconstrained agent harness across everyday coding tasks:

| Interaction | Traditional agent harness | `pi-agent-kernel` (Passive Shield) | Tokens saved | Why |
|---|---|---|---|---|
| **Whole Benchmark Suite (8 tasks)** | Sprawling context / heavy tool suite (1.21M tokens) | Passive Shield + Supercharged Core 4 (465k tokens) | **-61.7% fewer tokens** | Gates speculative tools, stops schema overhead, and prevents tool distraction loops. |
| **Monorepo navigation (Zod, 140k+ LOC)** | Sprawling directory scans & full file dumps (104k tokens) | Surgical AST & clean plain reads (`read`) (50.5k tokens) | **-51.5% fewer tokens** | Capped 50KB/2,000-line reads and precise AST symbol targeting without hash overhead. |
| **Patching & Delimiter Repair** | Repetitive edit retry loops due to cutoffs (16.7% fail rate) | Tree-sitter & lexical auto-healing (`edit`) | **Zero-retry syntax healing** | Deterministically restores truncated closing braces/brackets before writing. |
| **Running tests / builds** | Floods context with raw build logs (~20k+ tokens) | Clamped output with disk spillover (~1.0k tokens) | **~95% context saved** | Full logs written to disk; agent sees head, tail, and log path. |
| **Function Inspection** | Reads full file with line hashes (~4.0k tokens) | Clean plain-text reads or symbol extraction (~420 tokens) | **~70–90% fewer tokens** | Clean plain text by default; surgical AST symbol targeting. |

---

## Cross-harness benchmark & reproducibility

`pi-agent-kernel` is continuously evaluated using an 8-task ground-truth benchmark suite derived from real-world bug fixes merged in popular open-source repositories (`hono`, `ky`, `zod`, `ufo`, `picomatch`, `fastify`, `uuid`, `p-limit`).

### Cross-Harness 8-Task Benchmark on GPT 5.6 Luna Medium (`cx/gpt-5.6-luna:medium`)

All 5 harnesses were evaluated across all 8 tasks under identical prompts and repository states on **`cx/gpt-5.6-luna:medium`** via **`OmniRoute`**:

| Harness | Tasks Solved | Success Rate | Total Time | Cumulative Input Tokens | Output Tokens | Total Turn Tokens | Total Tool Calls |
|---|:---:|:---:|---:|---:|---:|---:|:---:|
| **Pi (Vanilla)** | **8 / 8** | **100%** | **504s (8.4m)** | **332,092** | **9,233** | **494,413** | **62** |
| **Pi + Agent-Kernel** | **8 / 8** | **100%** | **745s (12.4m)** | **373,938** | **14,016** | **727,922** | **92** |
| **Codex CLI** | **8 / 8** | **100%** | 860s (14.3m) | 1,733,982 | 21,289 | 1,755,271 | 64 |
| **OMP** | **8 / 8** | **100%** | 849s (14.2m) | 576,233 | 11,921 | 1,978,234 | 194 |
| **Claude Code** | **8 / 8** | **100%** | 1,332s (22.2m) | 2,080,562 | 58,339 | 2,283,901 | 114 |

> **Efficiency Comparison**: Pi harness families (`pi-vanilla` and `pi-agent-kernel`) dramatically outperform external CLIs, consuming **58–78% fewer tokens** and completing tasks in nearly half the wall-clock time compared to Claude Code, Codex, and OMP.

![Benchmark Comparison](agent-kernel-benchmark/benchmark-comparison.png)

### Running the benchmark locally

```bash
# 1. Copy and customize configuration
cp agent-kernel-benchmark/.env.example agent-kernel-benchmark/.env

# 2. Run the full benchmark suite
npm run bench

# Or run a specific task / harness
npx tsx agent-kernel-benchmark/run.ts task-3
npx tsx agent-kernel-benchmark/run.ts --harnesses pi-kernel,pi-vanilla

# 3. Clean transient workspaces
npm run bench:clean

# 4. Generate the comparison chart from benchmark results
npm run bench:chart
```

See [`agent-kernel-benchmark/README.md`](agent-kernel-benchmark/README.md) for full configuration details, CLI flags, and task descriptions, and [`agent-kernel-benchmark/BENCHMARK_RESULTS.md`](agent-kernel-benchmark/BENCHMARK_RESULTS.md) for task-by-task forensic analysis.

---

## Quick start

### 1. Install

Install the extension directly with Pi's package manager:

```bash
# Global install (recommended)
pi install npm:@floydous/pi-agent-kernel

# Or install locally for the current repository only
pi install -l npm:@floydous/pi-agent-kernel
```

Restart Pi or start a new session. The extension registers its tools, guards, and status indicators automatically.

---

### 2. Configure the retrieval engine (`/engine`)

`pi-agent-kernel` includes an in-memory retrieval engine for keyword and semantic searches:

```text
/engine status
```

- **`lean`** *(default)*: Fast, AST-aware BM25 search. Consumes 0 MB background model RAM.
- **`hybrid`**: BM25 keyword search blended with lightweight local 256-dimension embeddings.
- **`full`**: Dense 768-dimension semantic embeddings for deep conceptual queries across large codebases.
- **`off`**: Turns off local index building if you only want AST and LSP tools.

Switch profiles at any time:
```text
/engine hybrid
# or
/engine full
```

---

### 3. Configure codebase scale profile (`/profile`)

Agent-kernel automatically scales its prompt context to the size of the repository. On light repositories (<10 implementation files, <50 KB code), the 1,024-token PageRank map is suppressed to minimize token usage. On larger projects, the map is injected automatically.

You can view or override this setting at any time:
```text
/profile status     # Check current profile and detected codebase metrics
/profile light      # Force light profile (suppress automatic repo-map injection)
/profile heavy      # Force heavy profile (always inject PageRank repo map)
/profile auto       # Auto-detect based on implementation code volume (default)
```
Or configure via environment variable:
```bash
export PI_CODEBASE_PROFILE=light   # or "heavy", "auto", "smart"
```

---

### 4. Setup language servers (`/lsp`)

Get real-time compiler diagnostics, definitions, and references without manual setup:

```text
/lsp
```

Running `/lsp` opens an interactive management screen showing active servers, connection status, and one-click installs for detected workspace languages.

Alternatively, install a server directly from the command line:
```text
/lsp install <language>    # e.g., python, typescript, rust, go, csharp, etc.
```

---

### 5. Tip: Turn off Pi documentation when working on your own projects

By default, Pi loads system prompt instructions explaining how to extend Pi itself (extensions, themes, skills, and TUI APIs).

When you are working on your own software—such as a React app, a Python backend, or a Rust crate—those internal Pi instructions take up room in your prompt that you do not need. You can silence them for the current session with:

```text
/pi-docs off
```

Turn it back on with `/pi-docs on` whenever you switch back to hacking on Pi extensions.

---

## Tool reference

| Tool | What it does |
|---|---|
| `read` | Read specific lines or extract an exact function, class, or type via AST (`symbol="name"`). |
| `edit` | Apply surgical search/replace patches with built-in syntax checks. |
| `write` | Create new files or perform complete rewrites when explicitly requested. |
| `get_repo_map` | Retrieve a concise, PageRank-ranked symbol overview of the codebase (~1k tokens). |
| `ast_search` | Search declarations across files using Tree-sitter AST queries, grouped cleanly by file. |
| `code_search` | Hybrid keyword and semantic chunk search with breadcrumb locations. |
| `lsp` | Query definitions, references, type hover docs, and diagnostics directly from language servers. |
| `recall` | Retrieve the full text of a deduplicated output previously replaced by a short reference tag. |
| `search_tools` | Search and activate deferred tools on demand. |

---

## License

ISC
