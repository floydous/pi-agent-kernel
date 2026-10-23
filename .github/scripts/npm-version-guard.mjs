import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export class ReleaseGuardError extends Error {}

export function validateVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleaseGuardError(`Invalid package version: ${String(version)}`);
  }
  return version;
}

export function validateTag(tagName, version) {
  const expected = `v${version}`;
  if (tagName !== expected) {
    throw new ReleaseGuardError(`Release tag ${tagName || "<empty>"} does not match package version ${version} (expected ${expected})`);
  }
  return tagName;
}

export function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new ReleaseGuardError("Unable to locate npm-cli.js without invoking a shell");
  }
  return found;
}

export function classifyNpmViewResult(result, expectedVersion) {
  const status = typeof result?.status === "number" ? result.status : 1;
  const stdout = String(result?.stdout ?? "");
  const stderr = String(result?.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;

  if (status === 0) {
    let reported;
    try {
      reported = JSON.parse(stdout.trim());
    } catch (error) {
      throw new ReleaseGuardError(`npm view returned invalid JSON: ${error.message}`);
    }
    if (typeof reported === "string") {
      return { published: true, version: reported };
    }
    if (!reported || typeof reported !== "object" || typeof reported.version !== "string") {
      throw new ReleaseGuardError("npm view response is missing a package version");
    }
    return {
      published: true,
      version: reported.version,
      gitHead: typeof reported.gitHead === "string" ? reported.gitHead : undefined,
      integrity:
        typeof reported["dist.integrity"] === "string"
          ? reported["dist.integrity"]
          : undefined,
    };
  }

  if (status !== 0 && stdout.trim()) {
    try {
      const errorJson = JSON.parse(stdout.trim());
      if (
        errorJson?.error?.code === "E404" &&
        typeof errorJson?.error?.summary === "string" &&
        (!expectedVersion ||
          errorJson.error.summary.includes(`No match found for version ${expectedVersion}`) ||
          /\bNot Found\b/i.test(errorJson.error.summary))
      ) {
        return { published: false };
      }
    } catch {}
  }

  const versionNotFoundPattern = expectedVersion
    ? new RegExp(`\\bNo match found for version\\s+${expectedVersion.replace(/\./g, "\\.")}\\b`, "i")
    : /\bNo match found for version\b/i;

  const unambiguousNotFound =
    /\bE404\b/.test(combined) &&
    (/\b404\s+Not Found\b/i.test(combined) || versionNotFoundPattern.test(combined));
  if (unambiguousNotFound) {
    return { published: false };
  }

  throw new ReleaseGuardError(`npm registry query failed without an unambiguous 404:\n${combined.trim()}`);
}

export function decideRelease({
  packageName,
  packageVersion,
  tagName,
  lookupVersion,
  expectedCommit,
}) {
  if (typeof packageName !== "string" || !packageName.trim()) {
    throw new ReleaseGuardError("package.json name is missing");
  }
  validateVersion(packageVersion);
  validateTag(tagName, packageVersion);
  let lookupResult;
  try {
    const raw = lookupVersion(`${packageName}@${packageVersion}`);
    lookupResult =
      typeof raw === "string"
        ? { status: 0, stdout: raw, stderr: "" }
        : raw && typeof raw === "object"
          ? raw
          : { status: 0, stdout: String(raw ?? ""), stderr: "" };
  } catch (error) {
    lookupResult = {
      status: typeof error?.status === "number" ? error.status : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? "") || String(error?.message ?? ""),
    };
  }
  const decision = classifyNpmViewResult(lookupResult, packageVersion);
  if (decision.published && decision.version !== packageVersion) {
    throw new ReleaseGuardError(
      `Registry returned ${decision.version} while checking ${packageName}@${packageVersion}`,
    );
  }
  if (decision.published && expectedCommit) {
    if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
      throw new ReleaseGuardError(`Invalid expected commit: ${expectedCommit}`);
    }
    if (!decision.gitHead) {
      throw new ReleaseGuardError("Published package is missing npm gitHead provenance");
    }
    if (decision.gitHead.toLowerCase() !== expectedCommit.toLowerCase()) {
      throw new ReleaseGuardError(
        `Published ${packageName}@${packageVersion} came from ${decision.gitHead}, not ${expectedCommit}`,
      );
    }
  }
  return {
    packageName,
    version: packageVersion,
    publish: decision.published ? "false" : "true",
    state: decision.published ? "already-published" : "publishable",
    gitHead: decision.gitHead,
    integrity: decision.integrity,
  };
}

export function runCli({
  tagName,
  registry = process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org/",
  expectedCommit = process.env.GITHUB_SHA,
  cwd = REPO_ROOT,
  lookupVersion = (specifier) => {
    const npmCli = resolveNpmCli();
    return execFileSync(
      process.execPath,
      [
        npmCli,
        "view",
        specifier,
        "version",
        "gitHead",
        "dist.integrity",
        "--json",
        "--registry",
        registry,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  },
} = {}) {
  const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  const decision = decideRelease({
    packageName: manifest.name,
    packageVersion: manifest.version,
    tagName,
    lookupVersion,
    expectedCommit,
  });

  const output = [
    `publish=${decision.publish}`,
    `state=${decision.state}`,
    `package=${decision.packageName}`,
    `version=${decision.version}`,
  ];
  if (decision.gitHead) output.push(`git_head=${decision.gitHead}`);
  if (decision.integrity) output.push(`integrity=${decision.integrity}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${output.join("\n")}\n`, "utf8");
  } else {
    console.log(output.join("\n"));
  }
  return decision;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli({ tagName: process.env.GITHUB_REF_NAME || "" });
  } catch (error) {
    console.error(`[release-guard] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
