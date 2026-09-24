import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveNpmCli } from "./npm-version-guard.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const MANIFEST_NAME = "artifact.json";

function firstPackResult(stdout) {
  const parsed = JSON.parse(stdout);
  const result = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
  if (!result || typeof result !== "object" || typeof result.filename !== "string") {
    throw new Error("npm pack did not return artifact metadata");
  }
  return result;
}

export function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function prepareReleaseArtifact({
  cwd = REPO_ROOT,
  outputDir = path.join(cwd, "release-package"),
  gitCommit = process.env.GITHUB_SHA || "local-uncommitted",
} = {}) {
  if (fs.existsSync(outputDir)) {
    const outputStat = fs.lstatSync(outputDir);
    if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
      throw new Error(`Release artifact path is not a real directory: ${outputDir}`);
    }
    if (fs.readdirSync(outputDir).length > 0) {
      throw new Error(`Release artifact directory is not empty: ${outputDir}`);
    }
  }
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const npmCli = resolveNpmCli();
  const stdout = execFileSync(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", outputDir],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const packed = firstPackResult(stdout);
  if (path.basename(packed.filename) !== packed.filename) {
    throw new Error(`Unsafe npm pack filename: ${packed.filename}`);
  }
  const tarballPath = path.join(outputDir, packed.filename);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`npm pack did not create ${tarballPath}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  const artifact = {
    schemaVersion: 1,
    package: packageJson.name,
    version: packageJson.version,
    filename: packed.filename,
    sha256: sha256File(tarballPath),
    integrity: packed.integrity,
    fileCount: packed.entryCount,
    size: packed.size,
    unpackedSize: packed.unpackedSize,
    gitCommit,
  };
  fs.writeFileSync(
    path.join(outputDir, MANIFEST_NAME),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
    { flag: "wx", mode: 0o600 },
  );
  return artifact;
}

export function verifyReleaseArtifact({
  cwd = REPO_ROOT,
  artifactDir = path.join(cwd, "release-package"),
  expectedCommit = process.env.GITHUB_SHA,
} = {}) {
  const manifestPath = path.join(artifactDir, MANIFEST_NAME);
  const artifact = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (artifact.schemaVersion !== 1) throw new Error("Unsupported release artifact schema");
  if (
    typeof artifact.filename !== "string" ||
    path.basename(artifact.filename) !== artifact.filename ||
    !artifact.filename.endsWith(".tgz")
  ) {
    throw new Error("Unsafe release artifact filename");
  }
  const tarballPath = path.join(artifactDir, artifact.filename);
  if (!fs.existsSync(tarballPath)) throw new Error("Release tarball is missing");
  const actualSha = sha256File(tarballPath);
  if (actualSha !== artifact.sha256) {
    throw new Error(`Release tarball hash mismatch: ${actualSha} != ${artifact.sha256}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  if (artifact.package !== packageJson.name || artifact.version !== packageJson.version) {
    throw new Error("Release artifact package metadata does not match package.json");
  }
  if (expectedCommit && artifact.gitCommit !== expectedCommit) {
    throw new Error(
      `Release artifact came from ${artifact.gitCommit}, not ${expectedCommit}`,
    );
  }
  return { ...artifact, tarballPath };
}

export function runPrepareCli() {
  const artifact = prepareReleaseArtifact();
  console.log(
    [
      `filename=${artifact.filename}`,
      `sha256=${artifact.sha256}`,
      `package=${artifact.package}`,
      `version=${artifact.version}`,
    ].join("\n"),
  );
}

export function runVerifyCli({
  cwd = REPO_ROOT,
  artifactDir = path.join(cwd, "release-package"),
  expectedCommit = process.env.GITHUB_SHA,
} = {}) {
  const artifact = verifyReleaseArtifact({ cwd, artifactDir, expectedCommit });
  const output = [
    `filename=${artifact.filename}`,
    `sha256=${artifact.sha256}`,
    `tarball=${artifact.tarballPath}`,
  ];
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${output.join("\n")}\n`, "utf8");
  } else {
    console.log(output.join("\n"));
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "verify") runVerifyCli();
    else runPrepareCli();
  } catch (error) {
    console.error(`[release-artifact] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
