import * as path from "node:path";
import type { SearchHit } from "../retrieval/search_index";
import { tokenizeCode } from "../retrieval/search_bm25";

export const CODE_SEARCH_MODES = ["auto", "full", "preview", "summary"] as const;
export type CodeSearchMode = (typeof CODE_SEARCH_MODES)[number];

/** Maximum automatic response size in characters (before the tool footer). */
export const AUTO_OUTPUT_BUDGET = 8_000;

const PREVIEW_LINE_LIMIT = 12;
const PREVIEW_CHAR_LIMIT = 1_400;
const AUTO_FULL_CHAR_LIMIT = 6_000;
const AUTO_PREVIEW_HIT_LIMIT = 3;

export interface FormattedCodeSearchResults {
	text: string;
	mode: Exclude<CodeSearchMode, "auto"> | "mixed";
	truncated: boolean;
}

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function languageFor(filePath: string): string {
	return path.extname(filePath).slice(1) || "text";
}

function compactSignature(signature: string): string {
	const normalized = signature.replace(/\s+/g, " ").trim();
	return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function hitHeader(hit: SearchHit): string {
	const chunk = hit.chunk;
	const signature = compactSignature(chunk.signature || "");
	const signal = hit.signal ? ` [${hit.signal}]` : "";
	const matches = hit.matches.length > 0
		? `; matches: ${hit.matches.slice(0, 5).join(", ")}`
		: "";
	const headline = signature && signature !== chunk.symbolName ? ` — ${signature}` : "";
	return `${normalizePath(chunk.filePath)}:${chunk.startLine}-${chunk.endLine} [${chunk.kind}] ${chunk.symbolName}${headline}${signal}${matches}`;
}

function fullHit(hit: SearchHit): string {
	const chunk = hit.chunk;
	return `${normalizePath(chunk.filePath)}:${chunk.startLine}-${chunk.endLine} [${chunk.kind}] ${chunk.symbolName} (${chunk.breadcrumb}):\n\`\`\`${languageFor(chunk.filePath)}\n${chunk.content}\n\`\`\``;
}

function summaryHit(hit: SearchHit): string {
	return hitHeader(hit);
}

function bestMatchingLine(lines: string[], queryTerms: string[]): number {
	if (lines.length === 0 || queryTerms.length === 0) return 0;

	let bestIndex = 0;
	let bestScore = 0;
	for (let index = 0; index < lines.length; index++) {
		const lowerLine = lines[index].toLowerCase();
		const score = queryTerms.reduce(
			(total, term) => total + (lowerLine.includes(term) ? 1 : 0),
			0,
		);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = index;
		}
	}
	return bestIndex;
}

/**
 * Return a bounded excerpt around the query-bearing line rather than always
 * returning the beginning of a large AST chunk. This preserves evidence for
 * the search decision while avoiding a forced full-file read in the common
 * multi-result case.
 */
function queryPreview(hit: SearchHit, query: string): string {
	const lines = hit.chunk.content.split("\n");
	const terms = Array.from(new Set(tokenizeCode(query)));
	const bestLine = bestMatchingLine(lines, terms);
	const halfBefore = 2;
	let start = Math.max(0, bestLine - halfBefore);
	if (start + PREVIEW_LINE_LIMIT > lines.length) {
		start = Math.max(0, lines.length - PREVIEW_LINE_LIMIT);
	}
	const end = Math.min(lines.length, start + PREVIEW_LINE_LIMIT);
	const excerpt = lines.slice(start, end).join("\n");
	const lineStart = hit.chunk.startLine + start;
	const lineEnd = hit.chunk.startLine + end - 1;
	const before = start > 0 ? `... lines ${hit.chunk.startLine}-${lineStart - 1} omitted ...\n` : "";
	const after = end < lines.length ? `\n... lines ${lineEnd + 1}-${hit.chunk.endLine} omitted ...` : "";
	const boundedExcerpt = `${before}${excerpt}${after}`;
	const clipped = boundedExcerpt.length > PREVIEW_CHAR_LIMIT
		? `${boundedExcerpt.slice(0, PREVIEW_CHAR_LIMIT)}\n... preview clipped ...`
		: boundedExcerpt;
	return `${hitHeader(hit)}\n\`\`\`${languageFor(hit.chunk.filePath)}\n${clipped}\n\`\`\``;
}

function clipToBudget(text: string, budget: number): string {
	if (text.length <= budget) return text;
	if (budget <= 40) return text.slice(0, budget);
	return `${text.slice(0, budget - 27)}\n... output clipped ...`;
}

function applyBudget(entries: string[], budget: number): { text: string; truncated: boolean } {
	const selected: string[] = [];
	let used = 0;
	let omitted = 0;
	let truncated = false;

	for (let index = 0; index < entries.length; index++) {
		const separator = selected.length > 0 ? "\n\n" : "";
		const candidateLength = separator.length + entries[index].length;
		if (used + candidateLength <= budget) {
			selected.push(entries[index]);
			used += candidateLength;
			continue;
		}

		if (selected.length === 0) {
			const clipped = clipToBudget(entries[index], budget);
			selected.push(clipped);
			used = clipped.length;
			truncated = clipped.length < entries[index].length;
			// The first entry is present (possibly clipped), so only entries after
			// it are "additional" matches omitted from the response.
			omitted = entries.length - index - 1;
		} else {
			omitted = entries.length - index;
			truncated = true;
		}
		break;
	}

	if (omitted > 0) {
		const notice = `... ${omitted} additional match${omitted === 1 ? "" : "es"} omitted; use mode: "full" or a narrower query to inspect them ...`;
		const separator = selected.length > 0 ? "\n\n" : "";
		const remaining = Math.max(0, budget - used - separator.length);
		if (remaining > 0) {
			const clippedNotice = clipToBudget(notice, remaining);
			selected.push(clippedNotice);
			truncated = truncated || clippedNotice.length < notice.length;
		}
	}

	return { text: selected.join("\n\n"), truncated };
}

function resolveAutoMode(hits: SearchHit[]): Exclude<CodeSearchMode, "auto"> | "mixed" {
	if (hits.length === 1 && hits[0].chunk.content.length <= AUTO_FULL_CHAR_LIMIT) {
		return "full";
	}
	if (hits.length <= 3) return "preview";
	return "mixed";
}

/**
 * Format search hits for the model. Explicit full mode preserves the legacy
 * response. Automatic mode is context-preserving: it previews a small number
 * of top hits, summarizes the rest, and enforces a total response budget.
 */
function decorateResult(
	result: FormattedCodeSearchResults,
	requestedMode: CodeSearchMode,
	hitCount: number,
): FormattedCodeSearchResults {
	const header = `[code_search mode=${requestedMode}->${result.mode}; matches=${hitCount}]`;
	// Explicit full mode is the compatibility escape hatch: preserve the
	// pre-change body exactly so callers that parse the legacy output do not
	// need to change. Auto-full still gets the diagnostic header below.
	if (result.mode === "full" && requestedMode === "full") {
		return result;
	}
	if (result.mode === "full") {
		return { ...result, text: `${header}\n\n${result.text}` };
	}

	const available = Math.max(0, AUTO_OUTPUT_BUDGET - header.length - 2);
	const boundedText = clipToBudget(result.text, available);
	return {
		...result,
		text: `${header}\n\n${boundedText}`,
		truncated: result.truncated || boundedText.length < result.text.length,
	};
}

/**
 * Format search hits for the model. Explicit full mode preserves the legacy
 * response. Automatic mode is context-preserving: it previews a small number
 * of top hits, summarizes the rest, and enforces a total response budget.
 */
export function formatCodeSearchResults(
	hits: SearchHit[],
	query: string,
	requestedMode: CodeSearchMode = "auto",
): FormattedCodeSearchResults {
	const autoMode = requestedMode === "auto" ? resolveAutoMode(hits) : requestedMode;

	if (autoMode === "full") {
		return decorateResult(
			{
				text: hits.map(fullHit).join("\n\n"),
				mode: "full",
				truncated: false,
			},
			requestedMode,
			hits.length,
		);
	}

	if (autoMode === "summary") {
		const bounded = applyBudget(hits.map(summaryHit), AUTO_OUTPUT_BUDGET);
		return decorateResult({ ...bounded, mode: "summary" }, requestedMode, hits.length);
	}

	if (autoMode === "preview") {
		const bounded = applyBudget(
			hits.map((hit) => queryPreview(hit, query)),
			AUTO_OUTPUT_BUDGET,
		);
		return decorateResult({ ...bounded, mode: "preview" }, requestedMode, hits.length);
	}

	// Automatic mode for many results: preserve useful body context for the
	// highest-ranked few hits and keep the rest as cheap navigational metadata.
	const topPreview = hits
		.slice(0, AUTO_PREVIEW_HIT_LIMIT)
		.map((hit) => queryPreview(hit, query));
	const remainingSummary = hits
		.slice(AUTO_PREVIEW_HIT_LIMIT)
		.map(summaryHit);
	const bounded = applyBudget([...topPreview, ...remainingSummary], AUTO_OUTPUT_BUDGET);
	return decorateResult({ ...bounded, mode: "mixed" }, requestedMode, hits.length);
}
