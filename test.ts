// Backwards-compatibility shim. The test suite has been split into one file
// per section under `tests/`. Run the full suite with either:
//
//   npx tsx test.ts           (this shim)
//   npx tsx tests/run-all.ts  (the actual runner)
//
// Or run an individual section:
//
//   npx tsx tests/section-13-epistemic-guard.ts
//
// See `tests/README.md` for the full list of section files.

import "./tests/run-all";
