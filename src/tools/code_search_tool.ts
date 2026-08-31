import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import * as path from "node:path";
import { globalEpistemicGuard } from "../safety/epistemic_guard";
import type { SearchDeps } from "./context";

/** Extracted from index.ts — registers the `code_search` tool. */
export function registerCodeSearchTool(
	pi: ExtensionAPI,
	deps: SearchDeps,
): void {
	// 5.5 Tool: `code_search` (Local Hybrid BM25 + Semantic AST Code Search)
	pi.registerTool({
		name: "code_search",
		label: "Codebase Search",
		description:
			"Search the codebase using hybrid BM25 and semantic ranking across AST-bounded code chunks with hierarchical breadcrumbs. Ideal for conceptual queries, keywords, and finding relevant functions.",
		promptSnippet:
			"Search codebase conceptually or by keywords via hybrid AST index",
		renderShell: "default",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query: natural language concepts, variable names, error messages, or task descriptions",
			}),
			file_pattern: Type.Optional(
				Type.String({
					description:
						"Optional normalized relative path substring (e.g. 'src/auth', '.py', 'test')",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"Maximum number of code chunks to return (default: 5, max: 15)",
				}),
			),
			rrf_k: Type.Optional(
				Type.Number({
					description: "Optional RRF smoothing constant from 1 to 200 (default: 60)",
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
			const query = (params.query || "").trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "[ERROR] Search query cannot be empty." }],
					details: { count: 0 },
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Searching code for "${query}"...` }],
			});
			const index = deps.getSearchIndex(ctx.cwd);
			const configuredLimit = deps.getConfig?.(ctx.cwd).retrieval.max_search_results ?? 5;
			const limit = Math.min(
				Math.max(params.limit ?? configuredLimit, 1),
				15,
			);

			const hits = await index.search(query, {
				limit,
				filePattern: params.file_pattern,
				rrfK: params.rrf_k,
			});

			const sessionId = deps.getSessionId(ctx);
			for (const hit of hits) {
				globalEpistemicGuard.recordFileSearched(
					hit.chunk.absolutePath,
					sessionId,
					ctx.cwd,
				);
			}

			if (hits.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No code chunks found matching "${query}". (Tips: Try 'ast_search' for exact symbol names or 'rg' for exact text literals).`,
						},
					],
					details: { count: 0 },
				};
			}

			const formatted = hits.map((hit) => {
				const chunk = hit.chunk;
				const normPath = chunk.filePath.replace(/\\/g, "/");
				const lang = path.extname(chunk.filePath).slice(1) || "text";
				return `${normPath}:${chunk.startLine}-${chunk.endLine} (${chunk.breadcrumb}):\n\`\`\`${lang}\n${chunk.content}\n\`\`\``;
			});

			return {
				content: [
					{
						type: "text",
						text: formatted.join("\n\n"),
					},
				],
				details: {
					count: hits.length,
					hits: hits.map((h) => ({
						id: h.chunk.id,
						score: h.rrfScore,
						signal: h.signal,
					})),
				},
			};
		},
		renderCall(args: any, theme: any, _context: any) {
			return makeOutputText(
				`${theme.fg("toolTitle", theme.bold("code_search"))} ${theme.fg("accent", `"${args?.query || ""}"`)}${args?.file_pattern ? ` in ${args.file_pattern}` : ""}`,
			);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (context.isError) {
				const errMsg =
					result.content?.find((c: any) => c.type === "text")?.text ||
					"Search failed";
				return makeOutputText(`\n${theme.fg("error", errMsg)}`);
			}
			if (!options.expanded) {
				return new Text("", 0, 0);
			}
			const output =
				result.content?.find((c: any) => c.type === "text")?.text || "";
			return makeOutputText(`\n${theme.fg("toolOutput", output)}`);
		},
	});
}
