import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import * as path from "node:path";
import * as fs from "node:fs";
import { extractSymbolContent } from "../retrieval/symbol_reader";
import { findSymbolSuggestions } from "../retrieval/ast_search";
import { computeLineHash, formatSmartAnchorLines } from "../editing/smart_anchor";
import {
	globalEpistemicGuard,
	resolveUserPath,
} from "../safety/epistemic_guard";
import type { SessionDeps } from "./context";

function countFileLines(filePath: string): number {
	return fs.readFileSync(filePath, "utf8").split("\n").length;
}

const MAX_READ_LINES = 2_000;
const MAX_READ_BYTES = 50 * 1024;

function shouldUseAnchors(
	params: any,
	benchmarkMethod: string | undefined,
	readMode: string | undefined,
	defaultAnchors: boolean,
	targeted: boolean,
 ): boolean {
	if (params.raw === true) return false;
	if (readMode === "plain") return false;
	if (readMode === "anchored") return true;
	if (benchmarkMethod === "hash-anchor") return true;
	if (benchmarkMethod === "adaptive") return params.anchors === true;
	if (benchmarkMethod === "line-range" || benchmarkMethod === "search-replace") return false;
	if (targeted) return params.anchors ?? defaultAnchors;
	return params.anchors === true;
}

function formatReadLine(
	lines: readonly string[],
	index: number,
	useAnchors: boolean,
	numberWidth: number,
	benchmarkMethod: string | undefined,
 ): string {
	const line = lines[index]!;
	if (useAnchors) {
		return `${String(index + 1).padStart(numberWidth, " ")}#${computeLineHash(lines, index)}│${line}`;
	}
	if (benchmarkMethod === "line-range" || benchmarkMethod === "adaptive") {
		return `${String(index + 1).padStart(numberWidth, " ")}│${line}`;
	}
	return line;
}

function selectReadLineIndexes(
	lines: readonly string[],
	startIdx: number,
	endIdx: number,
	formatLine: (index: number) => string,
 ): number[] {
	const indexes = Array.from({ length: endIdx - startIdx }, (_, index) => startIdx + index);
	const fits = (candidate: readonly number[]) =>
		candidate.length <= MAX_READ_LINES &&
		Buffer.byteLength(candidate.map(formatLine).join("\n"), "utf8") <= MAX_READ_BYTES;
	if (indexes.length <= MAX_READ_LINES && fits(indexes)) return indexes;
	const first = indexes[0];
	if (first !== undefined && Buffer.byteLength(formatLine(first), "utf8") > MAX_READ_BYTES) return [];
	let headCount = Math.min(MAX_READ_LINES, indexes.length);
	while (headCount > 0 && !fits(indexes.slice(0, headCount))) headCount--;
	return indexes.slice(0, headCount);
}

function lineRanges(indexes: readonly number[]): Array<{ startLine: number; endLine: number }> {
	const ranges: Array<{ startLine: number; endLine: number }> = [];
	for (const index of indexes) {
		const line = index + 1;
		const previous = ranges[ranges.length - 1];
		if (previous && previous.endLine === line - 1) previous.endLine = line;
		else ranges.push({ startLine: line, endLine: line });
	}
	return ranges;
}

/** Extracted from index.ts — registers the `read` tool. */
export function registerReadTool(pi: ExtensionAPI, deps: SessionDeps): void {
	// 6. Tool: `read` (Unified File Reader with Surgical AST Symbol Extraction - Replaces stock read tool)
	const editMethod = process.env.PI_EDIT_METHOD?.toLowerCase();
	const benchmarkMethod = ["line-range", "search-replace", "hash-anchor", "adaptive"].includes(editMethod || "") ? editMethod : undefined;
	const readMode = process.env.PI_READ_MODE?.toLowerCase();
	const readToolDefinition: any = {
		name: "read",
		label: "Read File / Symbol",
		description:
			benchmarkMethod === "line-range"
				? "Read source with line numbers for numeric line-range edits."
				: benchmarkMethod === "search-replace"
					? "Read source text for exact search/replace edits."
					: benchmarkMethod === "adaptive"
						? "Read bounded source with plain line numbers. Prefer unique search/replace; use numeric ranges when needed; request anchors only for uncertain targets."
						: "Read file contents or surgically extract an AST symbol (function, class, method, type). Broad reads are capped at 2,000 lines or 50KB. Pass anchors: true for LINE#HASH anchors or raw: true for plain text.",
		promptSnippet: "Read file lines or extract an AST symbol via 'symbol'",
		renderShell: "default",
		parameters: Type.Object({
			path: Type.String({
				description: "File path (relative or absolute)",
			}),
			symbol: Type.Optional(
				Type.String({
					description: "Symbol name to extract surgically without paging",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Start line number (1-indexed)",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum lines to read",
				}),
			),
			surrounding_lines: Type.Optional(
				Type.Number({
					description: "Extra surrounding context lines for symbol (default: 0)",
				}),
			),
			anchors: Type.Optional(
				Type.Boolean({
					description: "Format lines with LINE#HASH│ anchors (default: true for normal reads)",
				}),
			),
			raw: Type.Optional(
				Type.Boolean({
					description: "Output clean raw text without LINE#HASH│ anchors (same as anchors: false)",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: any,
			_signal: any,
			onUpdate: any,
			ctx: any,
		): Promise<any> {
			if (!params || typeof params !== "object" || !params.path) {
				return {
					content: [
						{ type: "text", text: "[READ ERROR] Missing required 'path' parameter." },
					],
					isError: true,
				};
			}

			const resolvedPath = resolveUserPath(params.path, ctx.cwd);
			if (!fs.existsSync(resolvedPath)) {
				return {
					content: [{ type: "text", text: `File not found: ${params.path}` }],
					isError: true,
				};
			}

			// Mode 1: Targeted AST symbol extraction
			if (params.symbol && params.symbol.trim()) {
				const sym = params.symbol.trim();
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Extracting symbol '${sym}' from ${params.path}...`,
						},
					],
				});
				let symbolSnapshot: string;
				try {
					symbolSnapshot = fs.readFileSync(resolvedPath, "utf8");
				} catch (error: any) {
					return {
						content: [
							{ type: "text", text: `[READ ERROR] Unable to read ${params.path}: ${error.message}` },
						],
						isError: true,
					};
				}
				const res = extractSymbolContent(
					resolvedPath,
					sym,
					{ surroundingLines: params.surrounding_lines },
					symbolSnapshot,
				);

				if (!res.found) {
					const suggestions = findSymbolSuggestions(
						ctx.cwd,
						resolvedPath,
						sym,
					);
					let errorText: string;
					if (res.error) {
						errorText = res.error;
					} else if (suggestions.length > 0) {
						const formattedSuggestions = suggestions
							.map(
								(s) =>
									`- ${s.name} (${s.filePath}:${s.line}) [${s.kind}] ${s.signature}`,
							)
							.join("\n");
						errorText = `Symbol '${sym}' not found in ${params.path}.\nDid you mean:\n${formattedSuggestions}`;
					} else {
						errorText = `Symbol '${sym}' not found in ${params.path}. Use 'ast_search' to locate symbols or 'rg' in bash to search text.`;
					}
					return {
						content: [{ type: "text", text: errorText }],
						details: {
							error: "symbol_not_found",
							query: sym,
							candidates: suggestions.map((s) => ({
								name: s.name,
								filePath: s.filePath,
								line: s.line,
								kind: s.kind,
							})),
						},
						isError: true,
					};
				}

				// Record the exact snapshot used for extraction only after a successful
				// symbol result; failed extraction must not authorize a mutation.
				globalEpistemicGuard.recordFileRead(
					resolvedPath,
					deps.getSessionId(ctx),
					ctx.cwd,
					symbolSnapshot,
					{
						coverage: {
							complete: false,
							ranges: res.symbols.map((symbol) => ({
								startLine: symbol.startLine,
								endLine: symbol.endLine,
							})),
							totalLines: countFileLines(resolvedPath),
						},
						provenance: "symbol",
						query: sym,
					},
				);

				const config = deps.getConfig?.(ctx.cwd);
				const defaultAnchors = config?.editing?.default_anchors ?? true;
				const configuredReadMode = readMode ?? config?.editing?.read_mode ?? "auto";
				const useAnchors = shouldUseAnchors(params, benchmarkMethod, configuredReadMode, defaultAnchors, true);

				const allFileLines = symbolSnapshot.split("\n");
				const formatted = res.symbols
					.map((s) => {
						const header = `// ${path.relative(ctx.cwd, s.filePath) || s.filePath}:${s.startLine}-${s.endLine} [${s.kind}] ${s.name}`;
						const body = useAnchors
							? formatSmartAnchorLines(allFileLines, s.startLine, s.endLine)
							: benchmarkMethod === "line-range"
								? allFileLines.slice(s.startLine - 1, s.endLine).map((line, index) => `${String(s.startLine + index).padStart(String(s.endLine).length, " ")}│${line}`).join("\n")
								: s.content;
						return `${header}\n${body}`;
					})
					.join("\n\n");

				return {
					content: [{ type: "text", text: formatted }],
					details: {
						count: res.symbols.length,
						symbols: res.symbols.map((s) => ({
							name: s.name,
							kind: s.kind,
							lines: `${s.startLine}-${s.endLine}`,
						})),
					},
				};
			}

			// Mode 2: Standard file reading
			try {
				const ext = path.extname(resolvedPath).toLowerCase();
				const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(
					ext,
				);
				if (isImage) {
					const maxImageBytes =
						deps.getConfig?.(ctx.cwd).safety.max_total_bytes ?? 20 * 1024;
					const imageSize = fs.statSync(resolvedPath).size;
					if (imageSize > maxImageBytes) {
						return {
							content: [
								{
									type: "text",
									text: `[READ ERROR] Image is ${imageSize} bytes; maximum allowed is ${maxImageBytes} bytes.`,
								},
							],
							details: { isImage: true, sizeBytes: imageSize, maxImageBytes },
							isError: true,
						};
					}
					const mimeMap: Record<string, string> = {
						".png": "image/png",
						".jpg": "image/jpeg",
						".jpeg": "image/jpeg",
						".gif": "image/gif",
						".webp": "image/webp",
						".bmp": "image/bmp",
					};
					const buffer = fs.readFileSync(resolvedPath);
					globalEpistemicGuard.recordFileRead(
						resolvedPath,
						deps.getSessionId(ctx),
						ctx.cwd,
						buffer,
						{
							coverage: { complete: true, ranges: [] },
							provenance: "read",
						},
					);
					const base64 = buffer.toString("base64");
					const mimeType = mimeMap[ext] || "image/png";
					return {
						content: [
							{
								type: "text",
								text: `Read image file [${mimeType}] (${(buffer.length / 1024).toFixed(1)} KB)`,
							},
							{ type: "image", data: base64, mimeType },
						],
						details: { isImage: true, sizeBytes: buffer.length },
					};
				}

				const content = fs.readFileSync(resolvedPath, "utf-8");
				const lines = content.split("\n");
				const totalLines = lines.length;

				// Validate pagination params explicitly. The previous truthiness
				// check silently coerced offset=0 -> 1, clamped negatives, and
				// treated limit=0 as "use the default 2000" — surprising behavior
				// for an out-of-range request.
				if (
					params.offset !== undefined &&
					(!Number.isFinite(params.offset) || params.offset < 1)
				) {
					return {
						content: [
							{
								type: "text",
								text: `[READ ERROR] Invalid offset=${params.offset}. 'offset' must be a number >= 1 (1-based line number).`,
							},
						],
						details: { offset: params.offset },
						isError: true,
					};
				}
				if (
					params.limit !== undefined &&
					(!Number.isFinite(params.limit) || params.limit < 1)
				) {
					return {
						content: [
							{
								type: "text",
								text: `[READ ERROR] Invalid limit=${params.limit}. 'limit' must be a number >= 1.`,
							},
						],
						details: { limit: params.limit },
						isError: true,
					};
				}

				const offset = params.offset ?? 1;
				const limit = params.limit ?? totalLines;
				const startIdx = offset - 1;

				// Offset past the end of file: return a clean error instead of an
				// empty slice with an inverted header and bogus continuation hint.
				if (startIdx >= totalLines) {
					return {
						content: [
							{
								type: "text",
								text: `[READ ERROR] offset=${offset} is beyond the end of the file (${totalLines} line${totalLines === 1 ? "" : "s"}). Re-read without 'offset' to see the whole file.`,
							},
						],
						details: { totalLines, offset },
						isError: true,
					};
				}
				const endIdx = Math.min(totalLines, startIdx + limit);
				const config = deps.getConfig?.(ctx.cwd);
				const defaultAnchors = config?.editing?.default_anchors ?? true;
				const configuredReadMode = readMode ?? config?.editing?.read_mode ?? "auto";
				const useAnchors = shouldUseAnchors(params, benchmarkMethod, configuredReadMode, defaultAnchors, false);
				const numberWidth = String(totalLines).length;
				const formatLine = (index: number) => formatReadLine(lines, index, useAnchors, numberWidth, benchmarkMethod);
				const firstLineBytes = Buffer.byteLength(formatLine(startIdx), "utf8");
				const oversizedFirstLine = firstLineBytes > MAX_READ_BYTES;
				const visibleIndexes = oversizedFirstLine ? [] : selectReadLineIndexes(lines, startIdx, endIdx, formatLine);
				const hiddenLines = endIdx - startIdx - visibleIndexes.length;
				const hasMore = hiddenLines > 0 || endIdx < totalLines;
				const outputLines = oversizedFirstLine
					? [`[Line ${startIdx + 1} is ${firstLineBytes} bytes, exceeds ${MAX_READ_BYTES} byte limit. Use bash to inspect this line in chunks.]`]
					: visibleIndexes.map(formatLine);
				if (hiddenLines > 0 && !oversizedFirstLine) {
					outputLines.push(`[...] ${hiddenLines} lines omitted [...]. Use offset=${startIdx + visibleIndexes.length + 1} to continue.`);
				}
				const isTruncated = oversizedFirstLine || hasMore || startIdx > 0;
				if (isTruncated && hasMore && !oversizedFirstLine && hiddenLines === 0) {
					const lastShown = visibleIndexes[visibleIndexes.length - 1]! + 1;
					outputLines.push(`\n[Showing ${visibleIndexes.length} of ${totalLines} lines. Use offset=${lastShown + 1} to continue.]`);
				}
				const coverageRanges = lineRanges(visibleIndexes);

				// Record only the lines actually exposed to the model. The full content
				// still supplies the freshness fingerprint without authorizing hidden lines.
				globalEpistemicGuard.recordFileRead(
					resolvedPath,
					deps.getSessionId(ctx),
					ctx.cwd,
					content,
					{
						coverage: {
							complete: !isTruncated && startIdx === 0 && endIdx === totalLines,
							ranges: coverageRanges,
							totalLines,
						},
						provenance: "read",
					},
				);

				return {
					content: [{ type: "text", text: outputLines.join("\n") }],
					details: { totalLines, offset, limit, shownLines: visibleIndexes.length, truncated: isTruncated },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to read file: ${err.message}` }],
					isError: true,
				};
			}
		},
		renderCall(args: any, theme: any, context: any) {
			const rawPath = args?.path || "";
			const relPath = rawPath
				? path.relative(context.cwd, rawPath) || rawPath
				: "";
			if (args?.symbol) {
				return makeOutputText(
					`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", args.symbol)} in ${theme.fg("dim", relPath)}`,
				);
			}
			const range =
				args?.offset || args?.limit
					? `:${args.offset ?? 1}${args.limit ? `-${(args.offset ?? 1) + args.limit - 1}` : ""}`
					: "";
			return makeOutputText(
				`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", relPath)}${theme.fg("warning", range)}`,
			);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (context.isError) {
				const errMsg =
					result.content?.find((c: any) => c.type === "text")?.text || "Read failed";
				return makeOutputText(`\n${theme.fg("error", errMsg)}`);
			}
			if (!options.expanded) {
				return new Text("", 0, 0);
			}
			const output =
				result.content?.find((c: any) => c.type === "text")?.text || "";
			return makeOutputText(`\n${theme.fg("toolOutput", output)}`);
		},
	};

	pi.registerTool(readToolDefinition);
}
