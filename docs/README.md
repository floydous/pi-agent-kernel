# Agent Kernel Documentation

This directory contains focused documentation for the `agent-kernel` Pi package.

## Design priorities

The extension targets bare-minimum token usage while maximizing performance and
reliability across agent work. Its documentation and implementation favor
focused retrieval, bounded output, deterministic verification, and grounded
edits instead of unnecessary context or background processing.

## Guides

- [Architecture](architecture.md) — source layout, subsystem boundaries, and runtime flow.
- [LSP](lsp.md) — language-server discovery, lifecycle, and diagnostics.
- [Configuration](configuration.md) — global, project-local, and environment configuration.
- [Editing and verification](editing-and-verification.md) — surgical edits, safety checks, and post-edit verification.
- [Retrieval](retrieval.md) — repository maps, AST search, and hybrid code search.
- [Testing](testing.md) — focused tests, the full suite, and verification policy.

The implementation lives under `src/`. This directory documents the public
contracts and operating behavior without duplicating source comments.
