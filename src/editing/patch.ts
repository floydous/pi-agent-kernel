import * as fs from "fs";
import * as path from "path";
import * as diff from "diff";
import { checkSyntaxContent } from "./git-verify";

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

// Compute line similarity (0.0 to 1.0)
function computeSimilarity(a: string, b: string): number {
	if (a === b) return 1.0;
	const len = Math.max(a.length, b.length);
	if (len === 0) return 1.0;
	const changes = diff.diffChars(a, b);
	let common = 0;
	for (const part of changes) {
		if (!part.added && !part.removed) {
			common += part.value.length;
		}
	}
	return common / len;
}

function applySingleBlock(
	content: string,
	search: string,
	replace: string,
): { success: boolean; newContent: string; strategy: string; error?: string } {
	// Preserve the file's original line-ending style: normalize everything to
	// LF for matching, then restore CRLF on the result if the source used it.
	// Without this, editing ONE line of a CRLF file silently rewrote the whole
	// file to LF (phantom whole-file diffs, autocrlf conflicts on Windows).
	const hadCrlf = content.includes("\r\n");

	// Normalize line endings
	const searchNorm = search.replace(/\r\n/g, "\n");
	const replaceNorm = replace.replace(/\r\n/g, "\n");
	const contentNorm = content.replace(/\r\n/g, "\n");

	// Strategy 1: Exact string match
	if (contentNorm.includes(searchNorm)) {
		const newContent = contentNorm.replace(searchNorm, () => replaceNorm);
		return {
			success: true,
			newContent: hadCrlf ? newContent.replace(/\n/g, "\r\n") : newContent,
			strategy: "exact",
		};
	}

	// Strategy 2: Line-by-line whitespace-trimmed match
	const contentLines = contentNorm.split("\n");
	const searchLines = searchNorm.split("\n").filter((l) => l.trim().length > 0);

	if (searchLines.length > 0) {
		let matchStartIndex = -1;

		for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
			let allMatch = true;
			for (let j = 0; j < searchLines.length; j++) {
				if (contentLines[i + j].trim() !== searchLines[j].trim()) {
					allMatch = false;
					break;
				}
			}
			if (allMatch) {
				matchStartIndex = i;
				break;
			}
		}

		if (matchStartIndex !== -1) {
			const beforeLines = contentLines.slice(0, matchStartIndex);
			const afterLines = contentLines.slice(matchStartIndex + searchLines.length);
			let newContent = [...beforeLines, replaceNorm, ...afterLines].join("\n");
			if (hadCrlf) newContent = newContent.replace(/\n/g, "\r\n");
			return { success: true, newContent, strategy: "whitespace_normalized" };
		}
	}

	// Strategy 3: Sliding window fuzzy similarity (> 0.85)
	if (searchLines.length > 0 && contentLines.length >= searchLines.length) {
		let bestScore = 0;
		let bestIndex = -1;

		for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
			let scoreSum = 0;
			for (let j = 0; j < searchLines.length; j++) {
				scoreSum += computeSimilarity(
					contentLines[i + j].trim(),
					searchLines[j].trim(),
				);
			}
			const avgScore = scoreSum / searchLines.length;
			if (avgScore > bestScore) {
				bestScore = avgScore;
				bestIndex = i;
			}
		}

		if (bestScore >= 0.85 && bestIndex !== -1) {
			const beforeLines = contentLines.slice(0, bestIndex);
			const afterLines = contentLines.slice(bestIndex + searchLines.length);
			let newContent = [...beforeLines, replaceNorm, ...afterLines].join("\n");
			if (hadCrlf) newContent = newContent.replace(/\n/g, "\r\n");
			return {
				success: true,
				newContent,
				strategy: `fuzzy (similarity: ${(bestScore * 100).toFixed(1)}%)`,
			};
		}
	}

	return {
		success: false,
		newContent: content,
		strategy: "none",
		error: `Could not locate SEARCH block. Check line context and try again.`,
	};
}

export function applySurgicalPatch(
	filePath: string,
	search: string,
	replace: string,
): PatchResult {
	const resolvedPath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);

	if (!fs.existsSync(resolvedPath)) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `File not found: ${resolvedPath}`,
		};
	}

	let content: string;
	try {
		content = fs.readFileSync(resolvedPath, "utf8");
	} catch (e: any) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `Unable to read file ${resolvedPath}: ${e.message}`,
		};
	}

	const originalContent = content;
	const res = applySingleBlock(content, search, replace);

	if (!res.success) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `${res.error} in ${resolvedPath}`,
		};
	}

	const syntax = checkSyntaxContent(resolvedPath, res.newContent);
	if (!syntax.valid) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: res.strategy,
			error: syntax.error || "Candidate syntax validation failed",
		};
	}

	fs.writeFileSync(resolvedPath, res.newContent, "utf8");
	const patchDiff = diff.createPatch(
		path.basename(resolvedPath),
		originalContent,
		res.newContent,
	);

	return {
		success: true,
		filePath: resolvedPath,
		strategy: res.strategy,
		diffOutput: patchDiff,
	};
}

export function applyMultiBlockPatch(
	filePath: string,
	blocks: PatchBlock[],
): PatchResult {
	const resolvedPath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);

	if (!fs.existsSync(resolvedPath)) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `File not found: ${resolvedPath}`,
		};
	}

	let content: string;
	try {
		content = fs.readFileSync(resolvedPath, "utf8");
	} catch (e: any) {
		return {
			success: false,
			filePath: resolvedPath,
			strategy: "none",
			error: `Unable to read file ${resolvedPath}: ${e.message}`,
		};
	}

	const originalContent = content;
	let currentContent = content;
	const appliedStrategies: string[] = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const res = applySingleBlock(currentContent, block.search, block.replace);
		if (!res.success) {
			return {
				success: false,
				filePath: resolvedPath,
				strategy: "none",
				error: `Block ${i + 1}/${blocks.length} failed: ${res.error} in ${resolvedPath}`,
			};
		}
		currentContent = res.newContent;
		appliedStrategies.push(`Block ${i + 1}: ${res.strategy}`);
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

	fs.writeFileSync(resolvedPath, currentContent, "utf8");
	const patchDiff = diff.createPatch(
		path.basename(resolvedPath),
		originalContent,
		currentContent,
	);

	return {
		success: true,
		filePath: resolvedPath,
		strategy: appliedStrategies.join(", "),
		diffOutput: patchDiff,
	};
}
