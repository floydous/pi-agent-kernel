import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import { globalEpistemicGuard } from "../safety/epistemic_guard";
import { formatCodeSearchResults, CODE_SEARCH_MODES, type CodeSearchMode } from "./code_search_output";
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
			"Search the codebase using hybrid BM25 and semantic ranking across AST-bounded code chunks. Automatic output preserves compact, query-focused context; use mode 'full' for complete bodies, and scope 'all' or 'prose' to include documentation.",
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
			mode: Type.Optional(
				Type.Union(CODE_SEARCH_MODES.map((mode) => Type.Literal(mode))),
			),
			scope: Type.Optional(
				Type.Union([
					Type.Literal("code"),
					Type.Literal("all"),
					Type.Literal("prose"),
				]),
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

			const requestedMode = params.mode ?? "auto";
			if (!(CODE_SEARCH_MODES as readonly string[]).includes(requestedMode)) {
				return {
					content: [{
						type: "text",
						text: `[ERROR] Invalid mode "${String(requestedMode)}". Use auto, full, preview, or summary.`,
					}],
					details: { count: 0 },
					isError: true,
				};
			}

			const scope = params.scope ?? "code";
			if (!["code", "all", "prose"].includes(scope)) {
				return {
					content: [{
						type: "text",
						text: `[ERROR] Invalid scope "${String(scope)}". Use code, all, or prose.`,
					}],
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
				scope,
			});

			const sessionId = deps.getSessionId(ctx);
			for (const hit of hits) {
				globalEpistemicGuard.recordFileSearched(
					hit.chunk.absolutePath,
					sessionId,
					ctx.cwd,
					{
						coverage: { complete: false, ranges: [] },
						provenance: "code_search",
						query,
					},
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

			const formatted = formatCodeSearchResults(
				hits,
				query,
				requestedMode as CodeSearchMode,
			);

			return {
				content: [
					{
						type: "text",
						text: formatted.text,
					},
				],
				details: {
					count: hits.length,
					mode: formatted.mode,
					requestedMode,
					scope,
					truncated: formatted.truncated,
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
