# Test Suite Audit Status (Last Updated: 2026-09-07)

## The Truth About "32 passed, 0 failed"

The full test suite (`npm test`) reports **32 passed, 0 failed**, but this number is **misleading**.

### What the 32 sections actually test

The 32 sections in `tests/run-all.ts` (sections 1, 3-7, 9-11, 13, 15-25, 29-38) primarily use the `TreeSitterEngine`-based extraction path by **pre-warming** the engine before assertions:

```ts
// Pre-warm pattern used in section 1, 19, 21, 22, 36:
await TreeSitterEngine.getInstance().init();
await TreeSitterEngine.getInstance().loadLanguages([".ts", ".py", ".rs", ...]);
```

This pre-warming routes `extractFileTags` through `src/retrieval/tree_sitter_engine.ts` (the **good** path), bypassing the regex fallback in `src/retrieval/repomap.ts` (the **broken** path).

### What the audit (Section 40) actually tests

`tests/section-40-strict-intent-audit-2.ts` does **not** pre-warm TreeSitter. It calls `extractFileTags` and `extractSymbolContent` directly with realistic polyglot workspace files. This exposes the regex fallback path.

### Bugs confirmed by Section 40 (18 total)

Without TreeSitter pre-warming, `extractFileTags` returns only top-level declarations and misses:

| Language | Bug | Affected Symbols |
|---|---|---|
| TypeScript | 11 methods not extracted | `withConnection`, `connectInternal`, `ping`, `endpoint`, `isActive`, `release`, `createDefault`, `runMigrations`, `start`, `handleRequest`, `getStats` |
| C# | 1 method not extracted | `FindById` |
| C++ | 1 method not extracted | `matrix_vector_multiply` |
| JavaScript | 4 methods not extracted | `get`, `set`, `delete`, `fetchJson` |
| Symbol Reader | 1 method not extracted | `handleRequest` (TS) |

The root cause is in `src/retrieval/repomap.ts:585-707` — the regex fallback only matches top-level patterns and never recursively walks into class bodies.

### Java syntax validator is a no-op

`src/editing/syntax-verify.ts:290` returns `valid: true, status: "not run"` for `.java` files, meaning malformed Java passes the syntax gate and is written to disk. This is a real bug confirmed by Section 39.

### Why we are NOT fixing these source-code bugs in this PR

Per the user's rules:
- The user explicitly said: *"you do not edit the source code of the extension, you only write the unittest, doesn't matter whether it fails or success, as long the unit is valid, and return the expected behavior and result. Make sure all the extension src code has near 100% code coverage by the tests."*

So the tests are written to document the **expected** behavior. The fact that they fail when run against the broken code is exactly what proves the bug. To fix the bugs, separate work would be needed in `src/`.

### How to run the audit yourself

```bash
# Audit 1 (Java syntax validator):
npx tsx tests/section-39-strict-intent-audit.ts

# Audit 2 (cold-state regex fallback bugs):
npx tsx tests/section-40-strict-intent-audit-2.ts
```

Both audits will display which source-code bugs exist.
