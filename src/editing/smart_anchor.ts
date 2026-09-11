import * as fs from "node:fs";
import * as path from "node:path";
import * as diff from "diff";
import { checkSyntaxContent } from "./syntax-verify";
import { writeFileSyncAtomic } from "../safety/atomic_write";
import type { PatchResult, PatchTargetRange } from "./patch";

// ─── FNV-1a 32-bit Context Line Hashing ─────────────────────────────────────
const HEX = "0123456789ABCDEF";
const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${HEX[h]}${HEX[l]}`;
});

export const ANCHOR_SEP = "#";
export const CONTENT_SEP = "│";
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function normalizeLine(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

function fnvHash(prev: string, curr: string, next: string): string {
	let hash = FNV_OFFSET;
	for (let i = 0; i < prev.length; i++) {
		hash = Math.imul(hash ^ prev.charCodeAt(i), FNV_PRIME);
	}
	hash = Math.imul(hash ^ 0, FNV_PRIME); // \0 delimiter
	for (let i = 0; i < curr.length; i++) {
		hash = Math.imul(hash ^ curr.charCodeAt(i), FNV_PRIME);
	}
	hash = Math.imul(hash ^ 0, FNV_PRIME); // \0 delimiter
	for (let i = 0; i < next.length; i++) {
		hash = Math.imul(hash ^ next.charCodeAt(i), FNV_PRIME);
	}
	return DICT[hash & 0xff];
}

/**
 * Compute context hash incorporating immediate neighbors.
 * Missing neighbors at file boundaries contribute an empty string.
 */
export function computeLineHash(fileLines: readonly string[], index: number): string {
	if (index < 0 || index >= fileLines.length) return "";
	const prev = index > 0 ? normalizeLine(fileLines[index - 1]!) : "";
	const curr = normalizeLine(fileLines[index]!);
	const next = index < fileLines.length - 1 ? normalizeLine(fileLines[index + 1]!) : "";
	return fnvHash(prev, curr, next);
}

/** Format file lines with padded line numbers and context anchors: ` 42#3F│code` */
export function formatSmartAnchorLines(
	fileLines: readonly string[],
	startLine = 1,
	endLine = fileLines.length,
): string {
	const totalDigits = String(endLine).length;
	const clampedStart = Math.max(1, startLine);
	const clampedEnd = Math.min(fileLines.length, endLine);

	return fileLines
		.slice(clampedStart - 1, clampedEnd)
		.map((line, idx) => {
			const lineNum = clampedStart + idx;
			const pad = String(lineNum).padStart(totalDigits, " ");
			const hash = computeLineHash(fileLines, lineNum - 1);
			return `${pad}${ANCHOR_SEP}${hash}${CONTENT_SEP}${line}`;
		})
		.join("\n");
}

// ─── Anchor Parsing ─────────────────────────────────────────────────────────

export interface ParsedAnchor {
	line: number;
	hash?: string;
	raw: string;
}

/**
 * Parse an anchor reference string or integer.
 * Accepts: "288#ZH", " 288#ZH│code", "288", or numeric 288.
 */
export function parseAnchorRef(ref: string | number): ParsedAnchor {
	if (typeof ref === "number") {
		if (!Number.isFinite(ref) || ref < 1) {
			throw new Error(`Invalid line number: ${ref}. Must be an integer >= 1.`);
		}
		return { line: Math.floor(ref), raw: String(ref) };
	}

	const core = ref.trim();
	if (!core) {
		throw new Error(`Empty anchor reference provided.`);
	}

	const match = core.match(/^(\d+)(?:#([0-9A-Fa-f]{2}))?(?:[│:].*)?$/);
	if (!match) {
		throw new Error(`Invalid anchor format "${ref}". Expected "LINE#HASH" (e.g. "42#3F") or line number "42".`);
	}

	const line = parseInt(match[1], 10);
	if (line < 1) {
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	}

	return {
		line,
		hash: match[2] ? match[2].toUpperCase() : undefined,
		raw: core,
	};
}

// ─── Anchor Validation & Neighbor Spillover Recovery ─────────────────────────

export interface SmartAnchorEditBlock {
	pos?: string | number;
	end?: string | number;
	start_line?: number;
	end_line?: number;
	lines?: string[];
	search?: string;
	replace?: string;
}

export interface ResolvedSmartSpan {
	startLine: number;
	endLine: number;
	replacementLines: string[];
	recoveredNeighbor?: boolean;
}

export interface SmartAnchorPreflightResult {
	success: boolean;
	error?: string;
	staleDetails?: string;
	targetRanges?: PatchTargetRange[];
	resolvedSpans?: ResolvedSmartSpan[];
}

function formatStaleAnchorError(
	fileLines: readonly string[],
	line: number,
	expectedHash: string,
	actualHash: string,
): string {
	const start = Math.max(1, line - 2);
	const end = Math.min(fileLines.length, line + 2);
	const preview = formatSmartAnchorLines(fileLines, start, end);
	return `[E_STALE_ANCHOR] Anchor mismatch at line ${line}: expected #${expectedHash}, actual file has #${actualHash}.\n` +
		`Current context:\n${preview}\nCopy the current anchors from above and retry.`;
}

/**
 * Preflight and resolve anchor blocks against file lines.
 * Applies neighbor tolerance [L-1, L+1] to recover from model attention spillover.
 */
export function preflightSmartAnchorEdits(
	fileContent: string,
	edits: SmartAnchorEditBlock[],
): SmartAnchorPreflightResult {
	const fileLines = fileContent.split("\n");
	const totalLines = fileLines.length;
	const resolvedSpans: ResolvedSmartSpan[] = [];
	const targetRanges: PatchTargetRange[] = [];

	for (let i = 0; i < edits.length; i++) {
		const block = edits[i];
		if (!block) continue;

		// Handle fallback search/replace block embedded in edits
		if (typeof block.search === "string" && typeof block.replace === "string") {
			const idx = fileContent.indexOf(block.search);
			if (idx < 0) {
				return {
					success: false,
					error: `[EDIT FAILED] Block ${i + 1}/${edits.length}: search text not found in file.`,
				};
			}
			const count = fileContent.split(block.search).length - 1;
			if (count > 1) {
				return {
					success: false,
					error: `[EDIT FAILED] Block ${i + 1}/${edits.length} is ambiguous: matched ${count} times in file.`,
				};
			}
			const beforeMatch = fileContent.slice(0, idx);
			const startL = beforeMatch.split("\n").length;
			const matchLines = block.search.split("\n").length;
			const endL = startL + matchLines - 1;
			resolvedSpans.push({
				startLine: startL,
				endLine: endL,
				replacementLines: block.replace.split("\n"),
			});
			targetRanges.push({ startLine: startL, endLine: endL });
			continue;
		}

		// Positional anchor resolution
		let startLine = block.start_line;
		let endLine = block.end_line;
		let startHash: string | undefined;
		let endHash: string | undefined;

		if (block.pos !== undefined) {
			try {
				const p = parseAnchorRef(block.pos);
				startLine = p.line;
				startHash = p.hash;
			} catch (err: any) {
				return { success: false, error: `Block ${i + 1}: ${err.message}` };
			}
		}

		if (block.end !== undefined) {
			try {
				const e = parseAnchorRef(block.end);
				endLine = e.line;
				endHash = e.hash;
			} catch (err: any) {
				return { success: false, error: `Block ${i + 1}: ${err.message}` };
			}
		}

		if (startLine === undefined) {
			return {
				success: false,
				error: `Block ${i + 1}: missing anchor. Must specify 'pos', 'start_line', or 'search'.`,
			};
		}
		if (endLine === undefined) {
			endLine = startLine;
		}

		if (startLine < 1 || startLine > totalLines) {
			return {
				success: false,
				error: `[E_RANGE_OOB] Block ${i + 1}: start line ${startLine} is out of file bounds (1-${totalLines}).`,
			};
		}
		if (endLine < startLine || endLine > totalLines) {
			return {
				success: false,
				error: `[E_RANGE_OOB] Block ${i + 1}: end line ${endLine} is invalid (start: ${startLine}, file lines: ${totalLines}).`,
			};
		}

		let recoveredNeighbor = false;

		// Verify Start Anchor Hash
		if (startHash) {
			const actualHash = computeLineHash(fileLines, startLine - 1);
			if (actualHash !== startHash) {
				// Neighbor tolerance check: attention spillover across adjacent lines
				const prevHash = startLine > 1 ? computeLineHash(fileLines, startLine - 2) : undefined;
				const nextHash = startLine < totalLines ? computeLineHash(fileLines, startLine) : undefined;

				if (startHash === prevHash || startHash === nextHash) {
					recoveredNeighbor = true;
				} else {
					return {
						success: false,
						error: formatStaleAnchorError(fileLines, startLine, startHash, actualHash),
					};
				}
			}
		}

		// Verify End Anchor Hash
		if (endHash) {
			const actualEndHash = computeLineHash(fileLines, endLine - 1);
			if (actualEndHash !== endHash) {
				const prevHash = endLine > 1 ? computeLineHash(fileLines, endLine - 2) : undefined;
				const nextHash = endLine < totalLines ? computeLineHash(fileLines, endLine) : undefined;

				if (endHash === prevHash || endHash === nextHash) {
					recoveredNeighbor = true;
				} else {
					return {
						success: false,
						error: formatStaleAnchorError(fileLines, endLine, endHash, actualEndHash),
					};
				}
			}
		}

		const replacementLines = Array.isArray(block.lines) ? block.lines : [];
		resolvedSpans.push({
			startLine,
			endLine,
			replacementLines,
			recoveredNeighbor,
		});
		targetRanges.push({ startLine, endLine });
	}

	// Check for conflicting / overlapping spans
	for (let j = 0; j < resolvedSpans.length; j++) {
		const left = resolvedSpans[j]!;
		for (let k = j + 1; k < resolvedSpans.length; k++) {
			const right = resolvedSpans[k]!;
			if (left.startLine <= right.endLine && right.startLine <= left.endLine) {
				return {
					success: false,
					error: `[E_EDIT_CONFLICT] Blocks ${j + 1} (lines ${left.startLine}-${left.endLine}) and ${k + 1} (lines ${right.startLine}-${right.endLine}) overlap. Merge them into a single edit or apply disjoint ranges.`,
				};
			}
		}
	}

	return {
		success: true,
		targetRanges,
		resolvedSpans,
	};
}

// ─── Applying Smart Anchor Edits ─────────────────────────────────────────────

export function applySmartAnchorEdits(
	filePath: string,
	edits: SmartAnchorEditBlock[],
): PatchResult {
	const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
	if (!fs.existsSync(resolvedPath)) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "smart_anchor",
			error: `File not found: ${resolvedPath}`,
		};
	}

	let originalContent: string;
	try {
		originalContent = fs.readFileSync(resolvedPath, "utf8");
	} catch (err: any) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "smart_anchor",
			error: `Unable to read ${resolvedPath}: ${err.message}`,
		};
	}

	const preflight = preflightSmartAnchorEdits(originalContent, edits);
	if (!preflight.success || !preflight.resolvedSpans) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "smart_anchor",
			error: preflight.error || "Failed to resolve anchor edits",
		};
	}

	const fileLines = originalContent.split("\n");
	const currentLines = [...fileLines];

	// Sort spans strictly bottom-to-top (descending line number) so edits do not shift earlier lines
	const sortedSpans = [...preflight.resolvedSpans].sort((a, b) => b.startLine - a.startLine);

	for (const span of sortedSpans) {
		const deleteCount = span.endLine - span.startLine + 1;
		currentLines.splice(span.startLine - 1, deleteCount, ...span.replacementLines);
	}

	const candidateContent = currentLines.join("\n");

	// Syntax validation gate
	const syntax = checkSyntaxContent(resolvedPath, candidateContent);
	if (!syntax.valid) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "smart_anchor",
			error: syntax.error || "Candidate syntax validation failed after anchor edits",
		};
	}

	// Freshness verification: ensure file didn't change on disk during resolution
	try {
		const diskCheck = fs.readFileSync(resolvedPath, "utf8");
		if (diskCheck !== originalContent) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "smart_anchor",
				error: `File changed while applying edits: ${resolvedPath}. Re-read and retry.`,
			};
		}
		writeFileSyncAtomic(resolvedPath, candidateContent);
	} catch (writeErr: any) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "smart_anchor",
			error: `Unable to write ${resolvedPath}: ${writeErr.message}`,
		};
	}

	// Unified diff output
	const diffOutput = diff.createPatch(
		resolvedPath,
		originalContent,
		candidateContent,
		"original",
		"modified",
	);

	return {
		success: true,
		filePath: resolvedPath,
		strategy: "smart_anchor",
		diffOutput,
		targetRanges: preflight.targetRanges,
	};
}
