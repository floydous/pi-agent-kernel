import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveTypeScriptCompiler } from "../../src/editing/syntax-verify";

export async function run(): Promise<void> {
  console.log("=== Running Runtime Packaging Dependency Tests ===");
  const root = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const rootLock = lock.packages?.[""];

  assert.equal(
    manifest.dependencies?.typescript,
    "^7.0.2",
    "TypeScript must be a runtime dependency because syntax-verify executes its CLI",
  );
  assert.equal(
    manifest.devDependencies?.typescript,
    undefined,
    "TypeScript must not be devDependency-only",
  );
  assert.equal(
    rootLock?.dependencies?.typescript,
    manifest.dependencies.typescript,
    "lockfile root must retain TypeScript as a production dependency",
  );
  assert.equal(
    rootLock?.devDependencies?.typescript,
    undefined,
    "lockfile root must not classify TypeScript as development-only",
  );
  assert.ok(
    manifest.files?.includes("src"),
    "runtime syntax verifier source must be included in the package",
  );
  const resolvedCompiler = resolveTypeScriptCompiler();
  assert.ok(
    fs.existsSync(resolvedCompiler),
    `resolved TypeScript CLI must exist: ${resolvedCompiler}`,
  );

  console.log("✓ TypeScript runtime packaging contract verified!");
}

if (require.main === module) {
  void run();
}
