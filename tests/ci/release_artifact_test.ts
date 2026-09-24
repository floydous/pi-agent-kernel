import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verifyReleaseArtifact,
  runVerifyCli,
} from "../../.github/scripts/release-artifact.mjs";

export async function run(): Promise<void> {
  console.log("=== Running Verified Release Artifact Tests ===");
  const repo = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-artifact-test-"));
  const commit = "a".repeat(40);
  const filename = "floydous-pi-agent-kernel-0.4.0.tgz";
  const tarball = path.join(artifactDir, filename);

  try {
    fs.writeFileSync(tarball, "verified tarball bytes");
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
    const artifact = {
      schemaVersion: 1,
      package: manifest.name,
      version: manifest.version,
      filename,
      sha256,
      gitCommit: commit,
    };
    fs.writeFileSync(
      path.join(artifactDir, "artifact.json"),
      JSON.stringify(artifact, null, 2),
    );

    const verified = verifyReleaseArtifact({
      cwd: repo,
      artifactDir,
      expectedCommit: commit,
    });
    assert.equal(verified.tarballPath, tarball);
    assert.equal(verified.sha256, sha256);
    const outputFile = path.join(artifactDir, "github-output.txt");
    const previousOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputFile;
    try {
      runVerifyCli({ cwd: repo, artifactDir, expectedCommit: commit });
      const output = fs.readFileSync(outputFile, "utf8");
      assert.match(output, new RegExp(`filename=${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(output, /sha256=/);
    } finally {
      if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = previousOutput;
    }

    fs.appendFileSync(tarball, "tampered");
    assert.throws(
      () => verifyReleaseArtifact({ cwd: repo, artifactDir, expectedCommit: commit }),
      /hash mismatch/,
    );
    fs.writeFileSync(tarball, "verified tarball bytes");

    fs.writeFileSync(
      path.join(artifactDir, "artifact.json"),
      JSON.stringify({ ...artifact, filename: "../escape.tgz" }, null, 2),
    );
    assert.throws(
      () => verifyReleaseArtifact({ cwd: repo, artifactDir, expectedCommit: commit }),
      /Unsafe release artifact filename/,
    );

    fs.writeFileSync(
      path.join(artifactDir, "artifact.json"),
      JSON.stringify({ ...artifact, package: "unexpected/package" }, null, 2),
    );
    assert.throws(
      () => verifyReleaseArtifact({ cwd: repo, artifactDir, expectedCommit: commit }),
      /does not match package\.json/,
    );

    const workflow = fs.readFileSync(
      path.join(repo, ".github", "workflows", "release.yml"),
      "utf8",
    );
    const buildIndex = workflow.indexOf("release-artifact.mjs");
    const uploadIndex = workflow.indexOf("actions/upload-artifact@");
    const downloadIndex = workflow.indexOf("actions/download-artifact@");
    const verifyIndex = workflow.indexOf("release-artifact.mjs verify");
    const publishIndex = workflow.indexOf("steps.artifact.outputs.filename");
    assert.ok(buildIndex >= 0 && buildIndex < uploadIndex, "verify job must build before upload");
    assert.ok(uploadIndex < downloadIndex, "publish job must download the verified artifact");
    assert.ok(downloadIndex < verifyIndex && verifyIndex < publishIndex, "artifact must be verified before publish");
    assert.match(
      workflow,
      /npm publish "release-package\/\$\{\{ steps\.artifact\.outputs\.filename \}\}"/,
      "publish must use the verified tarball filename",
    );
    assert.doesNotMatch(
      workflow,
      /run: npm publish --provenance/,
      "publish must not rebuild an implicit package",
    );

    console.log("✓ Exact artifact hash, traversal, metadata, workflow ordering, and publish path verified!");
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void run();
}
