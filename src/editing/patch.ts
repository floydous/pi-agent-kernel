import * as fs from "fs";
import * as path from "node:path";
import { resolveUserPath } from "../safety/epistemic_guard";
import * as diff from "diff";
import { checkSyntaxContent } from "./syntax-verify";
import { writeFileSyncAtomic } from "../safety/atomic_write";
import { getUnclosedDelimiters, healJsonContent } from "./auto_heal";
/**
 * Result of composing and validating a surgical patch.
 *
 * `success: true` means the requested block was located, the complete
 * candidate content passed the local syntax gate, and the target was written.
 * It does not imply type correctness, semantic correctness, or clean LSP
 * diagnostics; those checks remain the caller's responsibility.
 */
export interface PatchResult {
	success: boolean;
	filePath: string;
	strategy: string;
	diffOutput?: string;
	error?: string;
	targetRanges?: PatchTargetRange[];
}

export interface PatchBlock {
	search: string;
	replace: string;
	startLine?: number;
	endLine?: number;
	lineHint?: number;
	start_line?: number;
	end_line?: number;
	line_hint?: number;
	autoHeal?: boolean;
}

/** Inclusive 1-based line span matched by an edit block before mutation. */
export interface PatchTargetRange {
	startLine: number;
	endLine: number;
}

function lineRangeFromOffsets(
	content: string,
	startOffset: number,
	length: number,
): PatchTargetRange {
	const startLine = content.slice(0, startOffset).split("\n").length;
	// When a match ends with a trailing newline (e.g. "foo\n"), that newline is the
	// delimiter terminating the line, not content on the next line.
	let effectiveLength = Math.max(length, 1);
	if (
		effectiveLength > 1 &&
		content.slice(startOffset, startOffset + effectiveLength).endsWith("\n")
	) {
		effectiveLength -= 1;
	}
	const matched = content.slice(startOffset, startOffset + effectiveLength);
	return {
		startLine,
		endLine: startLine + Math.max(0, matched.split("\n").length - 1),
	};
}

function computeSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	const len = Math.max(a.length, b.length);
	if (len === 0) return 1;
	const changes = diff.diffChars(a, b);
	let common = 0;
	for (const part of changes) {
		if (!part.added && !part.removed) common += part.value.length;
	}
	return common / len;
}

function restoreLineEndings(content: string, hadCrlf: boolean): string {
	return hadCrlf ? content.replace(/\n/g, "\r\n") : content;
}

function replaceLineWindow(
	contentLines: string[],
	start: number,
	length: number,
	replacement: string,
	hadCrlf: boolean,
): string {
	return restoreLineEndings(
		[
			...contentLines.slice(0, start),
			replacement,
			...contentLines.slice(start + length),
		].join("\n"),
		hadCrlf,
	);
}

function applySingleBlock(
	content: string,
	search: string,
	replace: string,
	options?: {
		startLine?: number;
		endLine?: number;
		lineHint?: number;
		start_line?: number;
		end_line?: number;
		line_hint?: number;
	},
): {
	success: boolean;
	newContent: string;
	strategy: string;
	error?: string;
	targetRange?: PatchTargetRange;
	autoHealed?: boolean;
} {
	const hadCrlf = content.includes("\r\n");
	const searchNorm = search.replace(/\r\n/g, "\n");
	const replaceNorm = replace.replace(/\r\n/g, "\n");
	const contentNorm = content.replace(/\r\n/g, "\n");

	if (!searchNorm.trim()) {
		return {
			success: false,
			newContent: content,
			strategy: "none",
			error: "SEARCH block cannot be empty or whitespace-only.",
		};
	}

	const hint = options?.lineHint ?? options?.line_hint ?? options?.startLine ?? options?.start_line;

	// Exact matching is safest, but duplicate or overlapping occurrences are
	// rejected rather than silently selecting one.
	const exactMatches: number[] = [];
	let exactOffset = contentNorm.indexOf(searchNorm);
	while (exactOffset !== -1) {
		exactMatches.push(exactOffset);
		exactOffset = contentNorm.indexOf(searchNorm, exactOffset + 1);
	}
	if (exactMatches.length === 1) {
		const start = exactMatches[0];
		const newContent =
			contentNorm.slice(0, start) +
			replaceNorm +
			contentNorm.slice(start + searchNorm.length);
		return {
			success: true,
			newContent: restoreLineEndings(newContent, hadCrlf),
			strategy: "exact",
			targetRange: lineRangeFromOffsets(contentNorm, start, searchNorm.length),
		};
	}
	if (exactMatches.length > 1) {
		if (hint !== undefined) {
			const targetLine = hint;
			let bestOffset = exactMatches[0];
			let bestDistance = Infinity;
			for (const offset of exactMatches) {
				const line = contentNorm.slice(0, offset).split("\n").length;
				const dist = Math.abs(line - targetLine);
				if (dist < bestDistance) {
					bestDistance = dist;
					bestOffset = offset;
				}
			}
			const start = bestOffset;
			const newContent =
				contentNorm.slice(0, start) +
				replaceNorm +
				contentNorm.slice(start + searchNorm.length);
			return {
				success: true,
				newContent: restoreLineEndings(newContent, hadCrlf),
				strategy: `exact (line-hinted near line ${contentNorm.slice(0, start).split("\n").length})`,
				targetRange: lineRangeFromOffsets(contentNorm, start, searchNorm.length),
			};
		}
		return {
			success: false,
			newContent: content,
			strategy: "none",
			error: `SEARCH block is ambiguous: found ${exactMatches.length} exact matches.`,
		};
	}

	// Keep every line in the normalized window, including leading, trailing, and
	// interior blank lines. Dropping any of them can make unrelated regions look
	// identical or remove formatting adjacent to the replacement.
	const contentLines = contentNorm.split("\n");
	const searchLines = searchNorm.split("\n");
	const normalizedSearch = searchLines.map((line) => line.trim());
	const normalizedMatches: number[] = [];

	for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
		let matches = true;
		for (let j = 0; j < searchLines.length; j++) {
			if (contentLines[i + j].trim() !== normalizedSearch[j]) {
				matches = false;
				break;
			}
		}
		if (matches) normalizedMatches.push(i);
	}

	if (normalizedMatches.length === 1) {
		return {
			success: true,
			newContent: replaceLineWindow(
				contentLines,
				normalizedMatches[0],
				searchLines.length,
				replaceNorm,
				hadCrlf,
			),
			strategy: "whitespace_normalized",
			targetRange: {
				startLine: normalizedMatches[0] + 1,
				endLine: normalizedMatches[0] + searchLines.length,
			},
		};
	}
	if (normalizedMatches.length > 1) {
		if (hint !== undefined) {
			const targetLine = hint;
			let bestIdx = normalizedMatches[0];
			let bestDistance = Infinity;
			for (const idx of normalizedMatches) {
				const line = idx + 1;
				const dist = Math.abs(line - targetLine);
				if (dist < bestDistance) {
					bestDistance = dist;
					bestIdx = idx;
				}
			}
			return {
				success: true,
				newContent: replaceLineWindow(
					contentLines,
					bestIdx,
					searchLines.length,
					replaceNorm,
					hadCrlf,
				),
				strategy: `whitespace_normalized (line-hinted near line ${bestIdx + 1})`,
				targetRange: {
					startLine: bestIdx + 1,
					endLine: bestIdx + searchLines.length,
				},
			};
		}
		return {
			success: false,
			newContent: content,
			strategy: "none",
			error: `SEARCH block is ambiguous: found ${normalizedMatches.length} whitespace-normalized matches.`,
		};
	}

	// Fuzzy matching is accepted only with a high score and a clear margin over
	// the next candidate. Ties and near-ties fail closed.
	const candidates: Array<{ index: number; score: number }> = [];
	for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
		let scoreSum = 0;
		for (let j = 0; j < searchLines.length; j++) {
			scoreSum += computeSimilarity(
				contentLines[i + j].trim(),
				searchLines[j].trim(),
			);
		}
		candidates.push({ index: i, score: scoreSum / searchLines.length });
	}
	candidates.sort((a, b) => b.score - a.score);

	const best = candidates[0];
	const second = candidates[1];
	const minimumScore = 0.85;
	const minimumMargin = 0.05;
	if (best && best.score >= minimumScore) {
		if (second && best.score - second.score < minimumMargin) {
			return {
				success: false,
				newContent: content,
				strategy: "none",
				error: `SEARCH block is ambiguous: fuzzy candidates are too close (${(best.score * 100).toFixed(1)}% best).`,
			};
		}
		return {
			success: true,
			newContent: replaceLineWindow(
				contentLines,
				best.index,
				searchLines.length,
				replaceNorm,
				hadCrlf,
			),
			strategy: `fuzzy (similarity: ${(best.score * 100).toFixed(1)}%)`,
			targetRange: {
				startLine: best.index + 1,
				endLine: best.index + searchLines.length,
			},
		};
	}

	return {
		success: false,
		newContent: content,
		strategy: "none",
		error: "Could not locate SEARCH block. Check line context and try again.",
	};
}

export interface PatchPreflightResult {
	success: boolean;
	targetRange?: PatchTargetRange;
	error?: string;
	isAmbiguous?: boolean;
}

/**
 * Preflight a single-block edit without mutating the target. Returns detailed
 * diagnostics including ambiguity detection and line coordinates.
 */
export function preflightSurgicalPatchBlock(
	filePath: string,
	search: string,
	options?: {
		startLine?: number;
		endLine?: number;
		lineHint?: number;
		start_line?: number;
		end_line?: number;
		line_hint?: number;
	},
): PatchPreflightResult {
	const resolvedPath = resolvePatchPath(filePath);
	const target = readPatchTarget(resolvedPath);
	if ("error" in target) {
		const err = (target.error as any).error || "Could not read target file";
		return { success: false, error: err };
	}
	const result = applySingleBlock(target.content, search, "", options);
	if (!result.success || !result.targetRange) {
		const isAmbiguous = (result.error?.toLowerCase() || "").includes("ambiguous");
		return {
			success: false,
			error: result.error || "Could not locate SEARCH block.",
			isAmbiguous,
		};
	}
	return { success: true, targetRange: result.targetRange };
}

/**
 * Locate a single-block edit without mutating the target. The edit tool uses
 * this narrow preflight to compare the matched span with visible read evidence.
 */
export function findSurgicalPatchTargetRange(
	filePath: string,
	search: string,
	options?: {
		startLine?: number;
		endLine?: number;
		lineHint?: number;
		start_line?: number;
		end_line?: number;
		line_hint?: number;
	},
): PatchTargetRange | null {
	const res = preflightSurgicalPatchBlock(filePath, search, options);
	return res.success ? res.targetRange ?? null : null;
}

function resolvePatchPath(filePath: string): string {
	return resolveUserPath(filePath, process.cwd());
}

function readPatchTarget(
	resolvedPath: string,
): { content: string } | { error: PatchResult } {
	if (!fs.existsSync(resolvedPath)) {
		return {
			error: {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `File not found: ${resolvedPath}`,
			},
		};
	}
	try {
		return { content: fs.readFileSync(resolvedPath, "utf8") };
	} catch (error: any) {
		return {
			error: {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `Unable to read file ${resolvedPath}: ${error.message}`,
			},
		};
	}
}

function writePatchedContent(
	resolvedPath: string,
	originalContent: string,
	newContent: string,
): PatchResult | null {
	// Avoid clobbering an external edit made after the patch was composed.
	try {
		if (fs.readFileSync(resolvedPath, "utf8") !== originalContent) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `File changed while the patch was being prepared: ${resolvedPath}. Re-read and retry.`,
			};
		}
		writeFileSyncAtomic(resolvedPath, newContent);
		return null;
	} catch (error: any) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `Unable to write ${resolvedPath}: ${error.message}`,
		};
	}
}

export function applySurgicalPatch(
	filePath: string,
	search: string,
	replace: string,
	options?: {
		startLine?: number;
		endLine?: number;
		lineHint?: number;
		start_line?: number;
		end_line?: number;
		line_hint?: number;
		autoHeal?: boolean;
	},
): PatchResult {
	const resolvedPath = resolvePatchPath(filePath);
	const target = readPatchTarget(resolvedPath);
	if ("error" in target) return target.error;

	const originalContent = target.content;
	const result = applySingleBlock(originalContent, search, replace, options);
	if (!result.success) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `${result.error} in ${resolvedPath}`,
		};
	}

	let candidateContent = result.newContent;
	let syntax = checkSyntaxContent(resolvedPath, candidateContent);
	let autoHealed = false;

	// Delimiter & Bracket Auto-Healing:
	if (!syntax.valid) {
		const ext = path.extname(resolvedPath).toLowerCase();
		if (ext === ".json") {
			const healedJson = healJsonContent(candidateContent);
			if (healedJson) {
				candidateContent = healedJson;
				syntax = checkSyntaxContent(resolvedPath, candidateContent);
				autoHealed = syntax.valid;
			}
		} else if (options?.autoHeal !== false) {
			// Check if the replacement block truncated closing delimiters
			const unclosed = getUnclosedDelimiters(replace);
			if (unclosed.length > 0) {
				const appendDelims = "\n" + unclosed.join("");
				const retryReplace = replace + appendDelims;
				const reResult = applySingleBlock(originalContent, search, retryReplace, options);
				if (reResult.success) {
					const reSyntax = checkSyntaxContent(resolvedPath, reResult.newContent);
					if (reSyntax.valid) {
						candidateContent = reResult.newContent;
						syntax = reSyntax;
						autoHealed = true;
					}
				}
			}
		}
	}

	if (!syntax.valid) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: result.strategy,
			error: syntax.error || "Candidate syntax validation failed",
		};
	}

	const writeError = writePatchedContent(
		resolvedPath,
		originalContent,
		candidateContent,
	);
	if (writeError) {
		writeError.strategy = result.strategy;
		return writeError;
	}

	const finalStrategy = autoHealed
		? `${result.strategy} (auto-healed syntax)`
		: result.strategy;

	return {
		success: true,
		filePath: resolvedPath,
		strategy: finalStrategy,
		targetRanges: result.targetRange ? [result.targetRange] : [],
		diffOutput: diff.createPatch(
			path.basename(resolvedPath),
			originalContent,
			candidateContent,
		),
	};
}

export function applyMultiBlockPatch(
	filePath: string,
	blocks: PatchBlock[],
): PatchResult {
	const resolvedPath = resolvePatchPath(filePath);
	const target = readPatchTarget(resolvedPath);
	if ("error" in target) return target.error;
	if (!Array.isArray(blocks) || blocks.length === 0) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: "At least one patch block is required.",
		};
	}

	const originalContent = target.content;
	const plannedRanges: PatchTargetRange[] = [];

	// Preflight every search against the same original snapshot. Returned ranges
	// deliberately use original-file coordinates so callers can compare them with
	// the read evidence used to authorize this atomic edit; they do not move when
	// an earlier replacement changes the line count.
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (
			!block ||
			typeof block.search !== "string" ||
			typeof block.replace !== "string"
		) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `Block ${i + 1}/${blocks.length} is malformed.`,
			};
		}

		const opt = {
			startLine: block.startLine ?? block.start_line,
			endLine: block.endLine ?? block.end_line,
			lineHint: block.lineHint ?? block.line_hint,
		};
		const located = applySingleBlock(originalContent, block.search, "", opt);
		if (!located.success || !located.targetRange) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `Block ${i + 1}/${blocks.length} failed: ${located.error} in ${resolvedPath}`,
			};
		}

		const overlaps = plannedRanges.some(
			(range) =>
				range.startLine <= located.targetRange!.endLine &&
				located.targetRange!.startLine <= range.endLine,
		);
		if (overlaps) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `Block ${i + 1}/${blocks.length} overlaps another patch target in ${resolvedPath}.`,
			};
		}
		plannedRanges.push({ ...located.targetRange });
	}

	let currentContent = originalContent;
	const appliedStrategies: string[] = [];
	let lineDelta = 0;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const baseStart = block.startLine ?? block.start_line;
		const baseEnd = block.endLine ?? block.end_line;
		const baseHint = block.lineHint ?? block.line_hint;
		const opt = {
			startLine: baseStart !== undefined ? baseStart + lineDelta : undefined,
			endLine: baseEnd !== undefined ? baseEnd + lineDelta : undefined,
			lineHint: baseHint !== undefined ? baseHint + lineDelta : undefined,
		};
		const result = applySingleBlock(currentContent, block.search, block.replace, opt);
		if (!result.success) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `Block ${i + 1}/${blocks.length} failed: ${result.error} in ${resolvedPath}`,
			};
		}
		const searchCount = block.search.split("\n").length;
		const replaceCount = block.replace.split("\n").length;
		lineDelta += (replaceCount - searchCount);
		currentContent = result.newContent;
		appliedStrategies.push(`Block ${i + 1}: ${result.strategy}`);
	}

	let candidateContent = currentContent;
	let syntax = checkSyntaxContent(resolvedPath, candidateContent);
	let autoHealed = false;

	if (!syntax.valid) {
		const ext = path.extname(resolvedPath).toLowerCase();
		if (ext === ".json") {
			const healedJson = healJsonContent(candidateContent);
			if (healedJson) {
				candidateContent = healedJson;
				syntax = checkSyntaxContent(resolvedPath, candidateContent);
				autoHealed = syntax.valid;
			}
		}
	}

	if (!syntax.valid) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: appliedStrategies.join(", "),
			error: syntax.error || "Candidate syntax validation failed",
		};
	}

	const writeError = writePatchedContent(
		resolvedPath,
		originalContent,
		candidateContent,
	);
	if (writeError) {
		writeError.strategy = appliedStrategies.join(", ");
		return writeError;
	}

	const finalStrategy = autoHealed
		? `${appliedStrategies.join(", ")} (auto-healed syntax)`
		: appliedStrategies.join(", ");

	return {
		success: true,
		filePath: resolvedPath,
		strategy: finalStrategy,
		targetRanges: plannedRanges,
		diffOutput: diff.createPatch(
			path.basename(resolvedPath),
			originalContent,
			candidateContent,
		),
	};
}
