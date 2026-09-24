import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { kernelDebug } from "./kernel_debug";

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    // Directory fsync is not available on every filesystem; rename is still
    // atomic, and the failure is intentionally non-fatal after the rename.
    kernelDebug(error);
  }
}

/**
 * Write a file through an exclusive sibling temp file, preserving metadata
 * where the platform exposes it. A plain writeFileSync can leave a truncated
 * destination after a crash; fsync + rename prevents that partial state.
 */
export function writeFileSyncAtomic(filePath: string, data: string | Buffer): void {
  const target = path.resolve(filePath);
  let targetStat: fs.Stats | undefined;
  try {
    targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      throw new Error("Refusing to atomically replace a symbolic-link target");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const mode = targetStat ? (targetStat.mode & 0o7777) : 0o600;
  const temp = `${target}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (targetStat && process.platform !== "win32") {
      fs.chmodSync(temp, mode);
      if (targetStat.uid !== process.getuid?.() || targetStat.gid !== process.getgid?.()) {
        fs.chownSync(temp, targetStat.uid, targetStat.gid);
      }
    }

    fs.renameSync(temp, target);
    syncDirectory(path.dirname(target));
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (closeError) { kernelDebug(closeError); }
    }
    try { fs.unlinkSync(temp); } catch (cleanupError) { kernelDebug(cleanupError); }
    throw error;
  }
}
