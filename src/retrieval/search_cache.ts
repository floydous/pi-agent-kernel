import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPiHomeDir } from "../config/kernel_config";

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function ensureDirectoryNoLinks(trustedRoot: string, target: string): string {
  const canonicalRoot = fs.realpathSync(trustedRoot);
  const relative = path.relative(canonicalRoot, target);
  if (!isWithin(canonicalRoot, target)) {
    throw new Error(`Search cache path escapes trusted root: ${target}`);
  }

  let current = canonicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Search cache path contains a link or non-directory: ${current}`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      try {
        fs.mkdirSync(current);
      } catch (mkdirError: any) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Search cache path changed to a link or non-directory: ${current}`);
      }
    }
  }

  const canonicalTarget = fs.realpathSync(current);
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    throw new Error(`Resolved search cache path escapes trusted root: ${canonicalTarget}`);
  }
  return canonicalTarget;
}

export function getSearchCacheDir(cwd: string): string {
  const workspace = fs.realpathSync(path.resolve(cwd));
  const workspaceId = crypto
    .createHash("sha256")
    .update(process.platform === "win32" ? workspace.toLowerCase() : workspace)
    .digest("hex")
    .slice(0, 24);
  const configuredPiRoot = path.resolve(getPiHomeDir());
  fs.mkdirSync(configuredPiRoot, { recursive: true });
  const trustedPiRoot = fs.realpathSync(configuredPiRoot);
  const trustedRoot = ensureDirectoryNoLinks(
    trustedPiRoot,
    path.join(trustedPiRoot, "cache", "agent-kernel", "search"),
  );
  return ensureDirectoryNoLinks(
    trustedRoot,
    path.join(trustedRoot, workspaceId),
  );
}
