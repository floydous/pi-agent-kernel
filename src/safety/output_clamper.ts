import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { kernelDebug } from "./kernel_debug";

export interface ClampingOptions {
	maxLineLength?: number; // Maximum width per line (default: 300)
	maxLines?: number; // Maximum lines shown to model (default: 40)
	maxTotalBytes?: number; // Maximum total bytes before spilling (default: 20 * 1024 = 20 KB)
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
 */
export function clampCommandOutput(
	rawText: string,
	command: string,
	options?: ClampingOptions,
): ClampingResult {
	const maxLineLength = options?.maxLineLength ?? 300;
	const maxLines = options?.maxLines ?? 40;
	const maxTotalBytes = options?.maxTotalBytes ?? 20 * 1024;

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

	// Save complete raw output to temporary spillover file (with bounded rotation by mtime to prevent unbounded tmp growth)
	let spilloverPath: string | undefined;
	try {
		const tempDir = os.tmpdir();
		// Prune older spillover logs (> 20 files, oldest first by mtime)
		try {
			const files = fs
				.readdirSync(tempDir)
				.filter((f) => f.startsWith("pi_bash_spillover_"))
				.map((name) => {
					const full = path.join(tempDir, name);
					try {
						return { name, full, mtime: fs.statSync(full).mtimeMs };
					} catch {
						return { name, full, mtime: 0 };
					}
				})
				.sort((a, b) => a.mtime - b.mtime);

			if (files.length > 20) {
				const toDelete = files.slice(0, files.length - 20);
				for (const item of toDelete) {
					try { fs.unlinkSync(item.full); } catch {}
				}
			}
		} catch {}

		const hash = crypto.randomBytes(4).toString("hex");
		spilloverPath = path.join(tempDir, `pi_bash_spillover_${hash}.log`);
		fs.writeFileSync(spilloverPath, rawText, "utf8");
	} catch (e) {
		kernelDebug(e);
	}

	// Horizontal Line-Width Clamping & Vertical Head+Tail Capping
	const clampedLines: string[] = [];

	const formatLine = (line: string, idx: number): string => {
		if (line.length > maxLineLength) {
			const kept = line.slice(0, Math.max(10, maxLineLength - 60));
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

	resultText += footer;

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
