# Testing

The suite is split into focused section files under `tests/`. Each section is
independently runnable and uses isolated temporary workspaces where needed.

## Commands

```sh
# Full compatibility entry point
npm test

# Direct section orchestrator
npm run test:focused

# One focused section
npx tsx tests/section-13-epistemic-guard.ts
```

The root `test.ts` imports `tests/run-all.ts` for compatibility with existing
commands and the `/oracle` default.

## Verification policy

Prefer the narrowest useful check first:

1. Run the focused section related to a change.
2. Run bounded TypeScript/LSP diagnostics for changed implementation files.
3. Run the full suite once the focused checks are understood.
4. Review `git diff --check` and the final working-tree status.

The suite covers AST extraction, repository maps, patching, syntax checks, Git
helpers, session repair, retrieval, output clamping, compaction, LSP support,
configuration, lifecycle integration, and post-edit verification.
