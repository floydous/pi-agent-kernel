# pi-agent-kernel

![Comparison Demonstration](https://raw.githubusercontent.com/floydous/pi-agent-kernel/master/static/comparison.gif)

Most coding agents drown in context. They read entire files when looking for a single function, dump thousands of lines of terminal logs into prompts, and rewrite full files just to tweak one line. `pi-agent-kernel` is built around a straightforward rule: **spend the bare minimum tokens necessary to get maximum workflow performance**. It provides surgical retrieval, bounded outputs, and guarded editing tools so your model stays fast, focused, and well within budget.

---

## Token savings

Here is how tool overhead compares to an unconstrained agent harness across everyday coding tasks:

| Interaction | Traditional agent harness | `pi-agent-kernel` | Tokens saved | Why |
|---|---|---|---|---|
| **Project orientation** | Walks directory tree, reads dozens of files (~92.8k tokens) | PageRank AST repository map (~1.0k tokens) | **~99% fewer tokens** | Only index-relevant code symbols and signatures are loaded. |
| **Inspecting a function** | Reads the full file (~1.5k–4.0k tokens) | Surgical symbol read: `read(symbol="foo")` (~420 tokens) | **~70–90% fewer tokens** | Pulls just the target AST node; skips line-number prefixes. |
| **Patching code** | Re-emits entire file content (~2.0k+ tokens) | Surgical search/replace block (`edit`) (~60 tokens) | **~95% fewer tokens** | Only generates the exact lines that change. |
| **Running tests / builds** | Floods context with raw build logs (~20k+ tokens) | Clamped output with disk spillover (~1.0k tokens) | **~95% context saved** | Full logs are written to disk; agent sees head, tail, and log path. |
| **AST symbol search** | Repeated absolute paths per match (~1.8k tokens) | Hierarchical grouped layout (~1.2k tokens) | **~34% fewer tokens** | Groups matching symbols under shared files and kinds. |

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

### 3. Setup language servers (`/lsp`)

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

### 4. Tip: Turn off Pi documentation when working on your own projects

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
