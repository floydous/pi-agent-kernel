# Language Server Protocol

LSP support lives under `src/lsp/`. It provides language-server discovery,
client lifecycle management, formatting, diagnostics, and interactive controls.

## Components

- `lsp_registry.ts` describes supported language servers.
- `lsp_detector.ts` detects a file language and workspace root.
- `lsp_client.ts` manages JSON-RPC communication with a server process.
- `lsp_manager.ts` owns client reuse, lifecycle, and status reporting.
- `lsp_formatter.ts` renders diagnostics and navigation results for agents.
- `lsp_installer.ts` handles optional server installation.
- `lsp_modal.ts` provides the interactive server-control UI.

## Edit verification

Post-edit verification only reuses a client that is already ready for the
edited file. It does not start a new server solely to verify an edit. If a
client is unavailable, the result remains explicitly `not run`, `unavailable`,
or otherwise uncertain; it is never presented as `clean`.

The LSP tool can request diagnostics, definitions, references, hover details,
and document symbols. AST-based fallback behavior is kept in
`src/retrieval/ast_search.ts` for cases where no ready language server can
answer the request.
