import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import * as path from "node:path";
import * as fs from "node:fs";
import { extractSymbolContent } from "../retrieval/symbol_reader";
import {
	globalEpistemicGuard,
	resolveUserPath,
} from "../safety/epistemic_guard";
import type { SessionDeps } from "./context";

function countFileLines(filePath: string): number {
	return fs.readFileSync(filePath, "utf8").split("\n").length;
}

/** Extracted from index.ts — registers the `read` tool. */
export function registerReadTool(pi: ExtensionAPI, deps: SessionDeps): void {
	// 6. Tool: `read` (Unified File Reader with Surgical AST Symbol Extraction - Replaces stock read tool)
	const readToolDefinition: any = {
		name: "read",
		label: "Read File / Symbol",
		description:
			"Read file contents (text/images) or surgically extract specific AST code symbols (function, class, method, interface, type). Supports optional pagination ('offset', 'limit') or direct surgical extraction via 'symbol'.",
		promptSnippet:
			"Read file contents or surgically extract specific AST code symbols via 'symbol'",
		renderShell: "default",
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to read (relative or absolute)",
			}),
			symbol: Type.Optional(
				Type.String({
					description:
						"Optional name of the function, class, method, or type to extract surgically from the file without paging",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description:
						"Line number to start reading from (1-indexed, for full file reading)",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of lines to read (for full file reading)",
				}),
			),
			surrounding_lines: Type.Optional(
				Type.Number({
					description:
						"Optional extra lines of surrounding context when extracting a symbol (default: 0)",
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
					return {
						content: [
							{
								type: "text",
								text:
									res.error ||
									`Symbol '${sym}' not found in ${params.path}. Use 'ast_search' to locate symbols or 'rg' in bash to search text.`,
							},
						],
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

				const formatted = res.symbols
					.map(
						(s) =>
							`// ${path.relative(ctx.cwd, s.filePath) || s.filePath}:${s.startLine}-${s.endLine} [${s.kind}] ${s.name}\n${s.content}`,
					)
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
				const limit = params.limit ?? 2000;
				const startIdx = offset - 1;

				// Offset past the end of file: return a clean error instead of an
				// empty slice with an inverted "Lines N-M" header and bogus hint.
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

				const selectedLines = lines.slice(startIdx, endIdx);
				const isTruncated = endIdx < totalLines || startIdx > 0;

				let output = selectedLines.join("\n");
				if (isTruncated) {
					output += `\n\n[Lines ${offset}-${endIdx}/${totalLines}. Next: offset=${endIdx + 1}]`;
				}

				// Record only after all bounds and pagination checks have succeeded.
				globalEpistemicGuard.recordFileRead(
					resolvedPath,
					deps.getSessionId(ctx),
					ctx.cwd,
					content,
					{
						coverage: {
							complete: !isTruncated,
							ranges: [{ startLine: offset, endLine: endIdx }],
							totalLines,
						},
						provenance: "read",
					},
				);

				return {
					content: [{ type: "text", text: output }],
					details: { totalLines, offset, limit, shownLines: selectedLines.length },
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
