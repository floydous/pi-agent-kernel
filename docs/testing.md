# Testing

The suite is split into focused suite directories under `tests/`. Each suite is
independently runnable and uses isolated temporary workspaces where needed.

## Commands

```sh
# Full suite
npm test

# One focused section
npx tsx tests/epistemic-guard/index.ts
```

`npm test` runs the suite orchestrator under `tests/`.

## Verification policy

Prefer the narrowest useful check first:

1. Run the focused suite related to a change.
2. Run bounded TypeScript/LSP diagnostics for changed implementation files.
3. Run the full suite once the focused checks are understood.
4. Review `git diff --check` and the final working-tree status.

The suite covers AST extraction, repository maps, patching, syntax checks,
session repair, retrieval, output clamping, LSP support, configuration,
lifecycle integration, and post-edit verification.

The `cold-process-ast` suite launches a fresh process per language and checks
required symbols, kinds, and local-scope exclusions. This catches warm singleton
state masking fallback defects.
