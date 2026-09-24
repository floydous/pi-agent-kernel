import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getPiHomeDir } from "../config/kernel_config";
import { kernelDebug } from "./kernel_debug";

export interface ClampingOptions {
	maxLineLength?: number; // Maximum width per line (default: 300)
	maxLines?: number; // Maximum lines shown to model (default: 40)
	maxTotalBytes?: number; // Maximum total bytes before spilling (default: 20 * 1024 = 20 KB)
	spilloverDir?: string;
	maxSpilloverFiles?: number;
	maxSpilloverBytes?: number;
}

export interface ClampingResult {
	text: string;
	truncated: boolean;
	spilloverPath?: string;
	originalBytes: number;
	returnedBytes: number;
	totalLines: number;
	shownLines: number;
}

const SPILL_PREFIX = "pi_bash_spillover_";
const DEFAULT_SPILL_FILES = 20;
const DEFAULT_SPILL_BYTES = 50 * 1024 * 1024;

export function getSpilloverRoot(cwd = process.cwd()): string {
	const base = getPiHomeDir();
	const workspaceId = crypto
		.createHash("sha256")
		.update(process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd))
		.digest("hex")
		.slice(0, 24);
	return path.join(base, "cache", "pi-agent-kernel", "spillover", workspaceId);
}

function ensureSpilloverDirectory(directory: string): string {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("Spillover directory must be a real directory");
	}
	return fs.realpathSync(directory);
}

function isOwnedRegularFile(filePath: string): boolean {
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile() || stat.isSymbolicLink()) return false;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return uid === undefined || stat.uid === uid;
	} catch {
		return false;
	}
}

function pruneSpillovers(directory: string, maxFiles: number, maxBytes: number): void {
	const files = fs
		.readdirSync(directory)
		.filter((name) => name.startsWith(SPILL_PREFIX))
		.map((name) => {
			const full = path.join(directory, name);
			try {
				const stat = fs.lstatSync(full);
				return { full, size: stat.size, mtime: stat.mtimeMs, owned: isOwnedRegularFile(full) };
			} catch {
				return { full, size: 0, mtime: 0, owned: false };
			}
		})
		.filter((item) => item.owned)
		.sort((a, b) => a.mtime - b.mtime);
	let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	let remainingFiles = files.length;
	for (const file of files) {
		if (remainingFiles <= maxFiles && totalBytes <= maxBytes) break;
		try {
			fs.unlinkSync(file.full);
			totalBytes -= file.size;
			remainingFiles--;
		} catch {}
	}
}

function writeSpillover(rawText: string, directory: string, maxFiles: number, maxBytes: number): string {
	const realDirectory = ensureSpilloverDirectory(directory);
	let candidate = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		candidate = path.join(realDirectory, `${SPILL_PREFIX}${crypto.randomBytes(16).toString("hex")}.log`);
		try {
			const fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			try {
				fs.writeFileSync(fd, rawText, "utf8");
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			pruneSpillovers(realDirectory, maxFiles, maxBytes);
			return candidate;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
		}
	}
	throw new Error("Unable to create an exclusive spillover file");
}

/**
 * Identify if a command is primarily a discovery/search/listing command
 * where aggressive line-width clamping and match capping should be enforced.
 */
export function isDiscoveryCommand(command: string): boolean {
	if (!command) return false;
	const trimmed = command.trim().toLowerCase();
	const firstWord = trimmed.split(/\s+/)[0];

	const discoveryTools = [
		"grep",
		"find",
		"rg",
		"ripgrep",
		"locate",
		"where",
		"which",
		"tree",
		"ls",
		"dir",
	];
	if (discoveryTools.includes(firstWord)) return true;

	// Check for piped discovery tools (e.g. `cat file | grep foo`)
	if (/\b(grep|find|rg|tree|ls)\b/.test(trimmed)) {
		return true;
	}

	return false;
}

/**
 * Clamps output lines horizontally and vertically to prevent context bloat
 * from single-line minified files, lockfiles, or massive multi-file matches.
 * Preserves 100% of raw output in an OS temp spillover file when truncation occurs.
 *
 * Adheres strictly to the language-agnostic conservative head/tail architecture:
 * never uses language-specific regex guessing to discard intermediate lines,
 * guaranteeing zero false-negative diagnostic suppression across arbitrary runtimes.
 */
export function clampCommandOutput(
	rawText: string,
	command: string,
	options?: ClampingOptions,
): ClampingResult {
	const maxLineLength = options?.maxLineLength ?? 300;
	const maxLines = options?.maxLines ?? 40;
	const maxTotalBytes = options?.maxTotalBytes ?? 20 * 1024;
	if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
		throw new RangeError("maxTotalBytes must be a nonnegative safe integer");
	}

	const originalBytes = Buffer.byteLength(rawText, "utf8");

	// If the entire output is small and within bounds, return as-is
	if (
		originalBytes <= maxTotalBytes &&
		!rawText.includes("\n") &&
		rawText.length <= maxLineLength
	) {
		return {
			text: rawText,
			truncated: false,
			originalBytes,
			returnedBytes: originalBytes,
			totalLines: 1,
			shownLines: 1,
		};
	}

	const rawLines = rawText.split(/\r?\n/);
	const totalLines = rawLines.length;
	let needsTruncation = false;

	// Check if any line violates maxLineLength or total lines violate maxLines
	if (totalLines > maxLines || originalBytes > maxTotalBytes) {
		needsTruncation = true;
	}

	for (const line of rawLines) {
		if (line.length > maxLineLength) {
			needsTruncation = true;
			break;
		}
	}

	// If no truncation is necessary, return clean output
	if (!needsTruncation) {
		return {
			text: rawText,
			truncated: false,
			originalBytes,
			returnedBytes: originalBytes,
			totalLines,
			shownLines: totalLines,
		};
	}

	let spilloverPath: string | undefined;
	try {
		const directory = options?.spilloverDir || getSpilloverRoot();
		const maxFiles = options?.maxSpilloverFiles ?? DEFAULT_SPILL_FILES;
		const maxBytes = options?.maxSpilloverBytes ?? DEFAULT_SPILL_BYTES;
		spilloverPath = writeSpillover(rawText, directory, maxFiles, maxBytes);
	} catch (e) {
		kernelDebug(e);
	}

	// Horizontal Line-Width Clamping & Vertical Head+Tail Capping
	const clampedLines: string[] = [];

	const formatLine = (line: string, idx: number): string => {
		if (line.length > maxLineLength) {
			let end = Math.max(10, maxLineLength - 60);
			// Do not split a valid UTF-16 surrogate pair.
			if (
				/[\uD800-\uDBFF]/.test(line.charAt(end - 1)) &&
				/[\uDC00-\uDFFF]/.test(line.charAt(end))
			)
				end--;
			const kept = line.slice(0, end);
			const omitted = line.length - kept.length;
			return `${kept}... <line ${idx + 1} truncated: ${omitted.toLocaleString()} chars omitted>`;
		}
		return line;
	};

	let shownLines = totalLines;

	if (totalLines > maxLines) {
		const effectiveMaxLines = Math.max(2, maxLines);
		const headCount = Math.floor(effectiveMaxLines / 2);
		const tailCount = effectiveMaxLines - headCount;
		const omittedLines = totalLines - (headCount + tailCount);
		shownLines = headCount + tailCount;

		// Head lines
		for (let i = 0; i < headCount; i++) {
			clampedLines.push(formatLine(rawLines[i], i));
		}

		// Middle omission marker
		clampedLines.push(
			`\n[... ${omittedLines.toLocaleString()} lines omitted ...]\n`,
		);

		// Tail lines
		const tailStart = totalLines - tailCount;
		for (let i = tailStart; i < totalLines; i++) {
			clampedLines.push(formatLine(rawLines[i], i));
		}
	} else {
		for (let i = 0; i < totalLines; i++) {
			clampedLines.push(formatLine(rawLines[i], i));
		}
	}

	let resultText = clampedLines.join("\n");

	// Append concise footer with spillover pointer
	let footer = `\n\n[Truncated: ${shownLines}/${totalLines} lines.`;
	if (spilloverPath) {
		footer += ` Full: ${spilloverPath}]`;
	} else {
		footer += `]`;
	}

	if (Buffer.byteLength(resultText + footer, "utf8") > maxTotalBytes) {
		const marker = clampedLines.findIndex((line) => /^\n\[\.\.\. /.test(line));
		if (marker !== -1) clampedLines.splice(marker, 1);
	}
	// Enforce the byte budget on the complete returned text: retain whole lines,
	// removing from the middle first so head and tail context survive.
	while (
		clampedLines.length &&
		Buffer.byteLength(clampedLines.join("\n") + footer, "utf8") > maxTotalBytes
	) {
		const [removed] = clampedLines.splice(
			Math.floor(clampedLines.length / 2),
			1,
		);
		if (!removed.startsWith("\n[... ")) shownLines--;
		footer =
			"\n\n[Truncated: " +
			shownLines +
			"/" +
			totalLines +
			" lines." +
			(spilloverPath ? " Full: " + spilloverPath + "]" : "]");
	}
	resultText = clampedLines.join("\n") + footer;
	if (Buffer.byteLength(resultText, "utf8") > maxTotalBytes) {
		// Budget too small for any recovery pointer: emit a bounded indication
		// without a chopped, unusable path.
		resultText = "[Truncated]".slice(0, maxTotalBytes);
	}

	const returnedBytes = Buffer.byteLength(resultText, "utf8");

	return {
		text: resultText,
		truncated: true,
		spilloverPath,
		originalBytes,
		returnedBytes,
		totalLines,
		shownLines,
	};
}
