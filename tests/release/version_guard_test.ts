import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ReleaseGuardError,
  decideRelease,
  runCli,
} from "../../.github/scripts/npm-version-guard.mjs";

function registryMissing(): never {
  throw Object.assign(new Error("not found"), {
    status: 1,
    stdout: "",
    stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/missing - Not found",
  });
}

function registryMissingVersion(version: string): () => never {
  return () => {
    throw Object.assign(new Error("not found"), {
      status: 1,
      stdout: JSON.stringify({
        error: {
          code: "E404",
          summary: `No match found for version ${version}`,
          detail: `The requested resource '@floydous/pi-agent-kernel@${version}' could not be found or you do not have permission to access it.`,
        },
      }),
      stderr: `npm error code E404\nnpm error 404 No match found for version ${version}`,
    });
  };
}

export async function run(): Promise<void> {
  console.log("=== Running Release Version Guard Tests ===");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const version = manifest.version;
  const queried: string[] = [];

  const publishedGitHead = "1".repeat(40);
  const publishedIntegrity = "sha512-test";
  const existing = decideRelease({
    packageName: manifest.name,
    packageVersion: version,
    tagName: `v${version}`,
    expectedCommit: publishedGitHead,
    lookupVersion(specifier: string) {
      queried.push(specifier);
      return {
        status: 0,
        stdout: JSON.stringify({
          version,
          gitHead: publishedGitHead,
          "dist.integrity": publishedIntegrity,
        }),
        stderr: "",
      };
    },
  });
  assert.equal(existing.publish, "false");
  assert.equal(existing.state, "already-published");
  assert.equal(existing.gitHead, publishedGitHead);
  assert.equal(existing.integrity, publishedIntegrity);
  assert.deepEqual(queried, [`${manifest.name}@${version}`]);

  assert.throws(
    () =>
      decideRelease({
        packageName: manifest.name,
        packageVersion: version,
        tagName: `v${version}`,
        expectedCommit: "2".repeat(40),
        lookupVersion: () => ({
          status: 0,
          stdout: JSON.stringify({ version, gitHead: publishedGitHead }),
        }),
      }),
    /came from .*not /,
  );

  const missing = decideRelease({
    packageName: manifest.name,
    packageVersion: version,
    tagName: `v${version}`,
    lookupVersion: registryMissing,
  });
  assert.equal(missing.publish, "true");
  assert.equal(missing.state, "publishable");

  const missingVersion = decideRelease({
    packageName: manifest.name,
    packageVersion: version,
    tagName: `v${version}`,
    lookupVersion: registryMissingVersion(version),
  });
  assert.equal(missingVersion.publish, "true");
  assert.equal(missingVersion.state, "publishable");

  // Mismatched missing version summary must fail closed
  assert.throws(
    () =>
      decideRelease({
        packageName: manifest.name,
        packageVersion: version,
        tagName: `v${version}`,
        lookupVersion: registryMissingVersion("9.9.9"),
      }),
    /without an unambiguous 404/,
  );

  // Generic permission-masked 404 without version match must fail closed
  assert.throws(
    () =>
      decideRelease({
        packageName: manifest.name,
        packageVersion: version,
        tagName: `v${version}`,
        lookupVersion: () => ({
          status: 1,
          stdout: JSON.stringify({
            error: {
              code: "E404",
              summary: "The requested resource could not be found or you do not have permission",
            },
          }),
          stderr: "npm error code E404",
        }),
      }),
    /without an unambiguous 404/,
  );

  assert.throws(
    () =>
      decideRelease({
        packageName: manifest.name,
        packageVersion: version,
        tagName: "v999.0.0",
        lookupVersion: () => ({ status: 0, stdout: JSON.stringify(version) }),
      }),
    /does not match package version/,
  );

  assert.throws(
    () =>
      decideRelease({
        packageName: manifest.name,
        packageVersion: version,
        tagName: `v${version}`,
        lookupVersion: () => ({
          status: 1,
          stdout: "",
          stderr: "npm error code E500\nnpm error 500 Internal Server Error",
        }),
      }),
    /without an unambiguous 404/,
  );

  assert.throws(
    () =>
      decideRelease({
        packageName: manifest.name,
        packageVersion: version,
        tagName: `v${version}`,
        lookupVersion: () => ({ status: 0, stdout: "not-json", stderr: "" }),
      }),
    /invalid JSON/,
  );

  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "release.yml"),
    "utf8",
  );
  const guardIndex = workflow.indexOf("id: release-check");
  const publishIndex = workflow.indexOf('run: npm publish "release-package/');
  const releaseIndex = workflow.indexOf("name: Create or verify GitHub release");
  assert.ok(guardIndex >= 0 && guardIndex < publishIndex, "registry guard must run before publish");
  assert.ok(publishIndex < releaseIndex, "GitHub release step must remain after publication decision");
  assert.match(
    workflow,
    /if: steps\.release-check\.outputs\.publish == 'true'/,
    "npm publish must only run when the guard emits publish=true",
  );
  assert.doesNotMatch(workflow, /continue-on-error/, "release guard failures must not be ignored");
  assert.doesNotMatch(
    workflow,
    /if:\s*always\(\)/,
    "GitHub release must not run after a genuine guard or publish failure",
  );
  assert.doesNotMatch(workflow, /RELEASE_NOTES\.tmp/);
  assert.match(workflow, /release-notes\.mjs/);

  const outputFile = path.join(os.tmpdir(), `github-output-${process.pid}-${Date.now()}.txt`);
  const previousOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputFile;
  try {
    runCli({
      tagName: `v${version}`,
      expectedCommit: publishedGitHead,
      lookupVersion: () => ({
        status: 0,
        stdout: JSON.stringify({ version, gitHead: publishedGitHead, "dist.integrity": publishedIntegrity }),
        stderr: "",
      }),
      cwd: process.cwd(),
    });
    const output = fs.readFileSync(outputFile, "utf8");
    assert.match(output, /publish=false/);
    assert.match(output, /git_head=/);
  } finally {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    try { fs.unlinkSync(outputFile); } catch {}
  }

  console.log("✓ Immutable release guard and fail-closed workflow behavior verified!");
}

if (require.main === module) {
  void run();
}
