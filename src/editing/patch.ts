import * as fs from "fs";
import * as path from "path";
import * as diff from "diff";
import { checkSyntaxContent } from "./syntax-verify";
import { writeFileSyncAtomic } from "../safety/atomic_write";

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
}

export interface PatchBlock {
	search: string;
	replace: string;
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
): { success: boolean; newContent: string; strategy: string; error?: string } {
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
		};
	}
	if (exactMatches.length > 1) {
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
		};
	}
	if (normalizedMatches.length > 1) {
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
		};
	}

	return {
		success: false,
		newContent: content,
		strategy: "none",
		error: "Could not locate SEARCH block. Check line context and try again.",
	};
}

function resolvePatchPath(filePath: string): string {
	return path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
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
): PatchResult {
	const resolvedPath = resolvePatchPath(filePath);
	const target = readPatchTarget(resolvedPath);
	if ("error" in target) return target.error;

	const originalContent = target.content;
	const result = applySingleBlock(originalContent, search, replace);
	if (!result.success) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `${result.error} in ${resolvedPath}`,
		};
	}

	const syntax = checkSyntaxContent(resolvedPath, result.newContent);
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
		result.newContent,
	);
	if (writeError) {
		writeError.strategy = result.strategy;
		return writeError;
	}

	return {
		success: true,
		filePath: resolvedPath,
		strategy: result.strategy,
		diffOutput: diff.createPatch(
			path.basename(resolvedPath),
			originalContent,
			result.newContent,
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
	let currentContent = originalContent;
	const appliedStrategies: string[] = [];

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
				strategy: appliedStrategies.join(", "),
				error: `Block ${i + 1}/${blocks.length} is malformed.`,
			};
		}
		const result = applySingleBlock(currentContent, block.search, block.replace);
		if (!result.success) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `Block ${i + 1}/${blocks.length} failed: ${result.error} in ${resolvedPath}`,
			};
		}
		currentContent = result.newContent;
		appliedStrategies.push(`Block ${i + 1}: ${result.strategy}`);
	}

	const syntax = checkSyntaxContent(resolvedPath, currentContent);
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
		currentContent,
	);
	if (writeError) {
		writeError.strategy = appliedStrategies.join(", ");
		return writeError;
	}

	return {
		success: true,
		filePath: resolvedPath,
		strategy: appliedStrategies.join(", "),
		diffOutput: diff.createPatch(
			path.basename(resolvedPath),
			originalContent,
			currentContent,
		),
	};
}
