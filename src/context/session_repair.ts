import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPiHomeDir } from "../config";
import { writeFileSyncAtomic } from "../safety/atomic_write";
import { kernelDebug } from "../safety/kernel_debug";

const MAX_SESSION_FILE_SIZE = 10 * 1024 * 1024;
const MAX_SESSIONS_SCANNED = 20;

export interface SessionRepairOptions {
	agentDir?: string;
	skipFile?: string;
	apply?: boolean;
}

export interface SessionRepairStats {
	scannedFiles: number;
	candidateFiles: number;
	repairedFiles: number;
	repairedEntries: number;
	skippedFiles: number;
	failedFiles: number;
	dryRun: boolean;
}

interface FileRepairResult {
	candidate: boolean;
	repaired: boolean;
	entries: number;
	skipped: boolean;
	error?: string;
}

function sha256(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function samePath(left: string, right: string): boolean {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32"
		? a.toLowerCase() === b.toLowerCase()
		: a === b;
}

function withRepairLock<T>(filePath: string, operation: () => T): T {
	const lockPath = `${filePath}.agent-kernel-repair.lock`;
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(lockPath, "wx", 0o600);
	} catch (error: any) {
		if (error?.code === "EEXIST") throw new Error("another repair holds the file lock");
		throw error;
	}
	try {
		fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
		return operation();
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		try {
			fs.unlinkSync(lockPath);
		} catch (error) {
			kernelDebug(error);
		}
	}
}

function repairSessionFile(filePath: string, apply: boolean): FileRepairResult {
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_FILE_SIZE) {
		return { candidate: false, repaired: false, entries: 0, skipped: true };
	}

	const original = fs.readFileSync(filePath, "utf8");
	let entriesRepaired = 0;
	const repairedLines = original.split("\n").map((line) => {
		if (!line.trim()) return line;
		try {
			const entry = JSON.parse(line);
			let modified = false;
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				if (!entry.usage.cost || typeof entry.usage.cost.total !== "number") {
					entry.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
					modified = true;
				}
			}
			if (entry.type === "message" && entry.message?.usage) {
				if (!entry.message.usage.cost || typeof entry.message.usage.cost.total !== "number") {
					entry.message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
					modified = true;
				}
			}
			if (modified) {
				entriesRepaired++;
				return JSON.stringify(entry);
			}
		} catch {
			// Leave malformed lines byte-for-byte unchanged.
		}
		return line;
	});

	if (entriesRepaired === 0) {
		return { candidate: false, repaired: false, entries: 0, skipped: false };
	}
	if (!apply) {
		return { candidate: true, repaired: false, entries: entriesRepaired, skipped: false };
	}

	const originalHash = sha256(original);
	const repairedContent = repairedLines.join("\n");
	return withRepairLock(filePath, () => {
		const current = fs.readFileSync(filePath, "utf8");
		if (sha256(current) !== originalHash) {
			return { candidate: true, repaired: false, entries: 0, skipped: true, error: "file changed during repair" };
		}

		const backupPath = `${filePath}.${Date.now()}.agent-kernel.bak`;
		fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
		if (sha256(fs.readFileSync(filePath, "utf8")) !== originalHash) {
			throw new Error("file changed before replacement");
		}
		writeFileSyncAtomic(filePath, repairedContent);
		if (fs.readFileSync(filePath, "utf8") !== repairedContent) {
			throw new Error("repaired content verification failed");
		}
		return { candidate: true, repaired: true, entries: entriesRepaired, skipped: false };
	});
}

export function sanitizeSessionFiles(
	optionsOrAgentDir: SessionRepairOptions | string = {},
): SessionRepairStats {
	const options = typeof optionsOrAgentDir === "string"
		? { agentDir: optionsOrAgentDir }
		: optionsOrAgentDir;
	const apply = options.apply === true;
	const stats: SessionRepairStats = {
		scannedFiles: 0,
		candidateFiles: 0,
		repairedFiles: 0,
		repairedEntries: 0,
		skippedFiles: 0,
		failedFiles: 0,
		dryRun: !apply,
	};

	try {
		const baseAgentDir = options.agentDir || path.join(getPiHomeDir(), "agent");
		const sessionsDir = path.join(baseAgentDir, "sessions");
		if (!fs.existsSync(sessionsDir)) return stats;

		const sessionFolders = fs.readdirSync(sessionsDir)
			.map((folder) => {
				const folderPath = path.join(sessionsDir, folder);
				try {
					const stat = fs.lstatSync(folderPath);
					return { folderPath, isDir: stat.isDirectory() && !stat.isSymbolicLink(), mtime: stat.mtimeMs };
				} catch {
					return { folderPath, isDir: false, mtime: 0 };
				}
			})
			.filter((folder) => folder.isDir)
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, MAX_SESSIONS_SCANNED);

		for (const { folderPath } of sessionFolders) {
			for (const file of fs.readdirSync(folderPath)) {
				if (!file.endsWith(".jsonl")) continue;
				const filePath = path.join(folderPath, file);
				if (options.skipFile && samePath(filePath, options.skipFile)) {
					stats.skippedFiles++;
					continue;
				}
				stats.scannedFiles++;
				try {
					const result = repairSessionFile(filePath, apply);
					if (result.candidate) stats.candidateFiles++;
					if (result.repaired) {
						stats.repairedFiles++;
						stats.repairedEntries += result.entries;
					}
					if (result.skipped) stats.skippedFiles++;
				} catch (error) {
					stats.failedFiles++;
					kernelDebug(`Session repair failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	} catch (error) {
		stats.failedFiles++;
		kernelDebug(error);
	}

	return stats;
}
