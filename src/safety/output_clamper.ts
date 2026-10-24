import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { getPiHomeDir } from "../config/kernel_config";
import { kernelDebug } from "./kernel_debug";

export interface ClampingOptions {
	maxLineLength?: number; // Maximum width per line (default: 300)
	maxLines?: number; // Maximum lines shown to model (default: 100)
	maxTotalBytes?: number; // Maximum total bytes before spilling (default: 20 * 1024 = 20 KB)
	spilloverDir?: string;
	maxSpilloverFiles?: number;
	maxSpilloverBytes?: number;
	isError?: boolean;
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

export function isExecutionOrTestCommand(command: string): boolean {
	if (!command) return false;
	const trimmed = command.trim().toLowerCase();
	return /\b(test|vitest|jest|pytest|ava|mocha|cargo|tsc|build|check)\b/.test(trimmed);
}

const HOST_TRUNCATION_REGEX =
	/(?:\r?\n){1,2}\[(?:Showing (?:lines \d+-\d+ of \d+(?: \([^)]+\))?|last [^)]+\))\.[ \t]*Full output:|Truncated by host harness\.[ \t]*Full:)[ \t]*([^\]\r\n]+?)(?:[ \t]+\(use offset\/limit with read if needed\))?\][ \t\r\n]*$/;

const KERNEL_TRUNCATION_REGEX =
	/(?:\r?\n){2}\[Truncated[^\r\n\]]*?(?:\.[ \t]*(?:Full|Spillover):[ \t]*([^\]\r\n]+?)(?:[ \t]+\(use offset\/limit[^)]*\)|[ \t]+\(received fragment only\))?)?\][ \t\r\n]*$/;

function validateHostSpilloverPath(candidatePath: string): string | undefined {
	try {
		const trimmed = candidatePath.trim().replace(/^["']|["']$/g, "");
		// Reject UNC paths and protocol paths
		if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) return undefined;

		const resolved = path.resolve(trimmed);
		if (!fs.existsSync(resolved)) return undefined;

		// Must not be a symbolic link and must be a regular file
		const lstat = fs.lstatSync(resolved);
		if (lstat.isSymbolicLink() || !lstat.isFile()) return undefined;

		// Filename must strictly match Pi core's accumulator naming convention: pi-(bash|powershell|output)-<hex>.log
		const base = path.basename(resolved);
		if (!/^pi-(?:bash|powershell|output)-[a-f0-9]+\.log$/i.test(base)) {
			return undefined;
		}

		// Must be directly contained in the OS temp directory (canonicalized real path)
		const realResolved = fs.realpathSync(resolved);
		const realTempDir = fs.realpathSync(os.tmpdir());
		const parentDir = path.dirname(realResolved);

		const isSameDir = process.platform === "win32"
			? parentDir.toLowerCase() === realTempDir.toLowerCase()
			: parentDir === realTempDir;

		if (!isSameDir) {
			return undefined;
		}

		return resolved;
	} catch (e: any) {
		kernelDebug(e);
		return undefined;
	}
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
	const maxLines = options?.maxLines ?? 100;
	const maxTotalBytes = options?.maxTotalBytes ?? 20 * 1024;
	if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
		throw new RangeError("maxTotalBytes must be a nonnegative safe integer");
	}

	// Detect prior truncation footer at the end of rawText:
	// either from host harness (Pi core) or an earlier Agent Kernel pass
	let textToProcess = rawText;
	let hostTruncated = false;
	let priorKernelTruncated = false;
	let hostSpilloverPath: string | undefined;
	let priorSpilloverPath: string | undefined;

	const hostMatch = rawText.match(HOST_TRUNCATION_REGEX);
	if (hostMatch && hostMatch.index !== undefined) {
		hostTruncated = true;
		textToProcess = rawText.slice(0, hostMatch.index);
		const candidate = hostMatch[1].trim();
		hostSpilloverPath = validateHostSpilloverPath(candidate);
	} else {
		const kernelMatch = rawText.match(KERNEL_TRUNCATION_REGEX);
		if (kernelMatch && kernelMatch.index !== undefined) {
			priorKernelTruncated = true;
			textToProcess = rawText.slice(0, kernelMatch.index);
			const candidate = kernelMatch[1]?.trim();
			if (candidate) {
				const cleanCandidate = candidate.replace(/\s*\(use offset\/limit.*\)$/i, "").trim();
				hostSpilloverPath = validateHostSpilloverPath(cleanCandidate);
				if (!hostSpilloverPath && fs.existsSync(cleanCandidate)) {
					try {
						const lstat = fs.lstatSync(cleanCandidate);
						if (!lstat.isSymbolicLink() && lstat.isFile()) {
							priorSpilloverPath = path.resolve(cleanCandidate);
						}
					} catch {}
				}
			}
		}
	}

	let originalBytes = Buffer.byteLength(rawText, "utf8");
	if (hostSpilloverPath) {
		try {
			originalBytes = fs.statSync(hostSpilloverPath).size;
		} catch {}
	} else if (priorSpilloverPath) {
		try {
			originalBytes = fs.statSync(priorSpilloverPath).size;
		} catch {}
	}

	// If the entire output is small, within bounds, and host did not truncate, return as-is
	if (
		!hostTruncated &&
		!priorKernelTruncated &&
		originalBytes <= maxTotalBytes &&
		!textToProcess.includes("\n") &&
		textToProcess.length <= maxLineLength
	) {
		return {
			text: textToProcess,
			truncated: false,
			originalBytes,
			returnedBytes: originalBytes,
			totalLines: 1,
			shownLines: 1,
		};
	}

	const rawLines = textToProcess.split(/\r?\n/);
	const totalLines = rawLines.length;
	let needsTruncation = hostTruncated || priorKernelTruncated;

	// Check if any line violates maxLineLength or total lines violate maxLines or bytes violate maxTotalBytes
	if (totalLines > maxLines || Buffer.byteLength(textToProcess, "utf8") > maxTotalBytes) {
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
			text: textToProcess,
			truncated: false,
			originalBytes,
			returnedBytes: originalBytes,
			totalLines,
			shownLines: totalLines,
		};
	}

	let spilloverPath = hostSpilloverPath || priorSpilloverPath;
	if (!spilloverPath) {
		try {
			const directory = options?.spilloverDir || getSpilloverRoot();
			const maxFiles = options?.maxSpilloverFiles ?? DEFAULT_SPILL_FILES;
			const maxBytes = options?.maxSpilloverBytes ?? DEFAULT_SPILL_BYTES;
			spilloverPath = writeSpillover(textToProcess, directory, maxFiles, maxBytes);
		} catch (e) {
			kernelDebug(e);
		}
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

	const DIAGNOSTIC_PATTERNS = [
		/^\s*(?:FAIL|✕|×)\s+\S+/,
		/\bAssertionError:\s/,
		/\berror\[E\d+\]:\s/,
		/\b(?:TypeError|SyntaxError|ReferenceError|Error):\s/,
		/-->\s+\S+:\d+:\d+/,
	];

	let primaryOmittedRange: { start: number; end: number; limit: number } | undefined;

	if (totalLines > maxLines) {
		const effectiveMaxLines = Math.max(2, maxLines);
		const isDiscovery = isDiscoveryCommand(command);
		const diagIndices: number[] = [];
		const isExplicitError = options?.isError === true;
		const isExplicitSuccess = options?.isError === false;
		const isUnflaggedTestOrBuild = options?.isError === undefined && !isDiscovery && isExecutionOrTestCommand(command);

		if (!isDiscovery && !isExplicitSuccess && (isExplicitError || isUnflaggedTestOrBuild)) {
			const patternsToScan = isExplicitError
				? DIAGNOSTIC_PATTERNS
				: [/^\s*(?:FAIL|✕|×)\s+\S+/, /-->\s+\S+:\d+:\d+/, /^\s*error\[E\d+\]:\s/];
			for (let i = 0; i < totalLines; i++) {
				if (patternsToScan.some((pat) => pat.test(rawLines[i]))) {
					diagIndices.push(i);
				}
			}
		}

		const hasDiagnosticFailure = !isDiscovery && !isExplicitSuccess && (isExplicitError || diagIndices.length > 0);

		if (hasDiagnosticFailure && effectiveMaxLines >= 8) {
			const headCount = Math.min(4, Math.max(2, Math.floor(effectiveMaxLines * 0.12)));
			const tailCount = Math.min(5, Math.max(2, Math.floor(effectiveMaxLines * 0.15)));
			const windowBudget = effectiveMaxLines - headCount - tailCount;

			let windowStart: number;
			let windowEnd: number;

			if (diagIndices.length > 0) {
				const primaryDiag = diagIndices[0];
				const half = Math.floor(windowBudget / 2);
				windowStart = Math.max(headCount, primaryDiag - half);
				windowEnd = Math.min(totalLines - tailCount, windowStart + windowBudget);
				if (windowEnd === totalLines - tailCount) {
					windowStart = Math.max(headCount, windowEnd - windowBudget);
				}
			} else {
				// No explicit pattern matched but isError is set: bias toward tail
				windowEnd = totalLines - tailCount;
				windowStart = Math.max(headCount, windowEnd - windowBudget);
			}

			// Head lines
			for (let i = 0; i < headCount; i++) {
				clampedLines.push(formatLine(rawLines[i], i));
			}
			if (windowStart > headCount) {
				const count = windowStart - headCount;
				clampedLines.push(`\n[... ${count.toLocaleString()} lines omitted (lines ${headCount + 1}–${windowStart}) ...]\n`);
				if (!primaryOmittedRange || count > primaryOmittedRange.limit) {
					primaryOmittedRange = { start: headCount + 1, end: windowStart, limit: count };
				}
			}
			// Diagnostic window
			for (let i = windowStart; i < windowEnd; i++) {
				clampedLines.push(formatLine(rawLines[i], i));
			}
			if (totalLines - tailCount > windowEnd) {
				const count = totalLines - tailCount - windowEnd;
				clampedLines.push(`\n[... ${count.toLocaleString()} lines omitted (lines ${windowEnd + 1}–${totalLines - tailCount}) ...]\n`);
				if (!primaryOmittedRange || count > primaryOmittedRange.limit) {
					primaryOmittedRange = { start: windowEnd + 1, end: totalLines - tailCount, limit: count };
				}
			}
			// Tail lines
			for (let i = totalLines - tailCount; i < totalLines; i++) {
				clampedLines.push(formatLine(rawLines[i], i));
			}
			shownLines = headCount + (windowEnd - windowStart) + tailCount;
		} else {
			// Standard symmetric head/tail split
			const headCount = Math.floor(effectiveMaxLines / 2);
			const tailCount = effectiveMaxLines - headCount;
			const omittedLines = totalLines - (headCount + tailCount);
			shownLines = headCount + tailCount;

			// Head lines
			for (let i = 0; i < headCount; i++) {
				clampedLines.push(formatLine(rawLines[i], i));
			}

			const tailStart = totalLines - tailCount;

			// Middle omission marker
			clampedLines.push(
				`\n[... ${omittedLines.toLocaleString()} lines omitted (lines ${headCount + 1}–${tailStart}) ...]\n`,
			);
			primaryOmittedRange = { start: headCount + 1, end: tailStart, limit: omittedLines };

			// Tail lines
			for (let i = tailStart; i < totalLines; i++) {
				clampedLines.push(formatLine(rawLines[i], i));
			}
		}
	} else {
		for (let i = 0; i < totalLines; i++) {
			clampedLines.push(formatLine(rawLines[i], i));
		}
	}

	let resultText = clampedLines.join("\n");

	const makeFooter = (linesShown: number): string => {
		if (hostTruncated || (priorKernelTruncated && hostSpilloverPath)) {
			if (hostSpilloverPath) {
				if (linesShown < totalLines) {
					return `\n\n[Truncated: ${linesShown} lines shown (host truncated). Full: ${hostSpilloverPath} (use offset/limit with read if needed)]`;
				}
				return `\n\n[Truncated by host harness. Full: ${hostSpilloverPath} (use offset/limit with read if needed)]`;
			}
			if (spilloverPath) {
				return `\n\n[Truncated by host harness. Spillover: ${spilloverPath} (received fragment only)]`;
			}
			return `\n\n[Truncated by host harness]`;
		}
		let f = `\n\n[Truncated: ${linesShown}/${totalLines} lines.`;
		if (spilloverPath) {
			f += ` Full: ${spilloverPath} (use offset/limit with read if needed)]`;
			if (primaryOmittedRange && maxTotalBytes >= 1024) {
				const boundedLimit = Math.min(250, primaryOmittedRange.limit);
				f += `\nTo inspect omitted lines ${primaryOmittedRange.start}–${primaryOmittedRange.end}: read({ path: "${spilloverPath}", offset: ${primaryOmittedRange.start}, limit: ${boundedLimit} })`;
			}
		} else {
			f += `]`;
		}
		return f;
	};

	// Append concise footer with spillover pointer
	let footer = makeFooter(shownLines);

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
		footer = makeFooter(shownLines);
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
