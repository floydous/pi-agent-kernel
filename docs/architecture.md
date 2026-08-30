# Architecture

`agent-kernel` is a lightweight Pi extension. Its authored runtime code is
under `src/`, while tests and project documentation remain outside the runtime
package.

## Layout

```text
src/
├── index.ts       Extension integration boundary
├── config/        Hierarchical TOML configuration
├── context/       Compaction and session repair
├── editing/       Surgical patching and verification
├── lsp/           Language Server Protocol support
├── retrieval/     AST, repository-map, and code-search logic
├── safety/        Read guards, output limits, and execution helpers
├── tools/         Pi tool registrations
└── ui/            Footer and terminal rendering helpers
```

## Boundaries

- `src/index.ts` wires the extension into Pi and registers commands, tools, and
  lifecycle handlers.
- `src/tools/` adapts kernel capabilities to Pi tool contracts. Tool modules
  receive explicit dependencies instead of creating hidden application state.
- `src/retrieval/`, `src/editing/`, `src/lsp/`, and `src/safety/` contain the
  reusable implementation modules.
- `src/config/` owns configuration loading and merging.
- `src/context/` owns compaction prompt construction and session repair.
- `src/ui/` contains presentation helpers and width-safe rendering utilities.

## Runtime flow

1. Pi loads `src/index.ts` from the package's `pi.extensions` declaration.
2. The extension loads configuration and registers its tools and commands.
3. Read and edit operations pass through the epistemic guard where enabled.
4. Retrieval operations use AST-aware indexing and bounded output contracts.
5. Edits are verified locally and return compact structured status text.
6. Compaction uses deterministic workspace state and recent trajectory data to
   build a grounded summary prompt.


