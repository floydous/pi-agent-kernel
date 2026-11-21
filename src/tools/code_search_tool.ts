import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import { globalEpistemicGuard } from "../safety/epistemic_guard";
import { formatCodeSearchResults, CODE_SEARCH_MODES, type CodeSearchMode } from "./code_search_output";
import { markReturnedErrors, type SearchDeps } from "./context";

/** Extracted from index.ts — registers the `code_search` tool. */
export function registerCodeSearchTool(
	pi: ExtensionAPI,
	deps: SearchDeps,
): void {
	// 5.5 Tool: `code_search` (Local AST-Chunk BM25 + Profile-Dependent Semantic Code Search)
	pi.registerTool(markReturnedErrors({
		name: "code_search",
		label: "Codebase Search",
		description:
			"AST-chunk BM25 keyword search across source code (with neural semantic fusion when the active profile enables embeddings). Use when locating features, workflows, UI behaviors, or architecture without known symbol names or file paths. Do NOT use for exact string literals, call-sites, or non-code files; use bash (rg -n) instead.",
		promptSnippet: "Search code chunks by mechanism keywords or concepts (BM25, plus vectors in full/auto profile)",
		renderShell: "default",
		parameters: Type.Object({
			query: Type.String({
				description: "Conceptual keywords or natural phrase (e.g., 'connection idle timeout', 'auth middleware')",
			}),
			file_pattern: Type.Optional(
				Type.String({
					description: "Optional relative path substring filter (e.g., 'src/auth', 'tests'). Omit for whole-workspace search. Do NOT guess paths.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 15,
					description: "Max results (default: 5, range: 1-15)",
				}),
			),
			mode: Type.Optional(
				Type.Unsafe<"auto" | "full" | "preview" | "summary">({
					type: "string",
					enum: ["auto", "full", "preview", "summary"],
					description: "Output detail level: 'auto' (adaptive), 'full' (complete chunk bodies), 'preview' (compact snippets), or 'summary' (headers only)",
				}),
			),
			rrf_k: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 200,
					description: "Optional Reciprocal Rank Fusion smoothing constant (1-200, default: 60)",
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
			if (deps.getConfig?.(ctx.cwd).retrieval.default_profile === "off") {
				return {
					content: [{ type: "text", text: "[ERROR] Code search is disabled for this workspace." }],
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
				separateTests: true,
			});

			const indexStatus = typeof index.getStatus === "function" ? index.getStatus() : undefined;
			const wantsVectors = indexStatus?.effectiveProfile === "full";
			const vectorNotice =
				wantsVectors &&
				indexStatus &&
				indexStatus.vectorCount < indexStatus.chunkCount
					? `[Notice: Vector embeddings are incomplete (${indexStatus.vectorCount}/${indexStatus.chunkCount} chunks); searched via BM25]\n\n`
					: "";
			const grammarIssues = indexStatus?.grammarIssues ?? [];
			const grammarNotice = grammarIssues.length > 0
				? `[Notice: tree-sitter grammar unavailable for ${grammarIssues.map((issue) => `${issue.extensions.join(", ")} (${issue.reason})`).join("; ")}; code structure for those files is approximate]\n\n`
				: "";
			const notIndexed = indexStatus?.notIndexed;
			const missingFiles = notIndexed ? notIndexed.source + notIndexed.test + notIndexed.vendored : 0;
			const count = (n: number) => n.toLocaleString("en-US");
			const coverageNotice = indexStatus && notIndexed && missingFiles > 0
				? `[Notice: index covers ${count(indexStatus.indexableFiles - missingFiles)} of ${indexStatus.walkTruncated ? "≥ " : ""}${count(indexStatus.indexableFiles)} indexable files (index limits); not indexed: ${(["source", "test", "vendored"] as const).filter((tier) => notIndexed[tier] > 0).map((tier) => `${count(notIndexed[tier])} ${tier}`).join(", ")} (${indexStatus.notIndexedDirs.join(", ")}); use rg for those paths]\n\n`
				: "";

			if (hits.length === 0) {
				// Blame the filter, not the query, when it excludes every indexed file (e.g. "README": docs are not indexed).
				const filterExcludesIndex = params.file_pattern && indexStatus && indexStatus.chunkCount > 0 &&
					typeof index.hasIndexedFile === "function" && !index.hasIndexedFile(params.file_pattern);
				let message: string;
				if (filterExcludesIndex) {
					message = `No indexed file path contains "${params.file_pattern}". code_search indexes source code only (not Markdown, JSON, YAML, TOML or other text files); use rg to search other files.`;
				} else if (indexStatus?.effectiveProfile === "full") {
					message = `No code chunks found matching "${query}". (Engine: Full [Neural RRF]. Tips: Try broader conceptual intent phrases if exact keywords failed; use 'rg' for exact text literals.)`;
				} else {
					message = `No code chunks found matching "${query}". (Engine: Lean [BM25 lexical]. Tips: Query with mechanism keywords or identifier patterns likely in source code; use 'rg' for exact text literals.)`;
				}
				return {
					content: [
						{
							type: "text",
							text: `${coverageNotice}${grammarNotice}${vectorNotice}${message}`,
						},
					],
					details: { count: 0, effectiveProfile: indexStatus?.effectiveProfile || "lean" },
				};
			}

			const formatted = formatCodeSearchResults(
				hits,
				query,
				requestedMode as CodeSearchMode,
			);
			const sessionId = deps.getSessionId(ctx);
			const hitById = new Map(hits.map((hit) => [hit.chunk.id, hit]));
			const visibleIds = new Set<string>();
			for (const range of formatted.visibleRanges) {
				const hit = hitById.get(range.chunkId);
				if (!hit) continue;
				visibleIds.add(range.chunkId);
				globalEpistemicGuard.recordFileRead(
					hit.chunk.absolutePath,
					sessionId,
					ctx.cwd,
					undefined,
					{
						coverage: {
							complete: false,
							ranges: [{ startLine: range.startLine, endLine: range.endLine }],
						},
						provenance: "code_search",
						query,
					},
				);
			}
			for (const hit of hits) {
				if (visibleIds.has(hit.chunk.id)) continue;
				globalEpistemicGuard.recordFileSearched(
					hit.chunk.absolutePath,
					sessionId,
					ctx.cwd,
					{ coverage: { complete: false, ranges: [] }, provenance: "code_search", query },
				);
			}

			return {
				content: [
					{
						type: "text",
						text: `${coverageNotice}${grammarNotice}${vectorNotice}${formatted.text}`,
					},
				],
				details: {
					count: hits.length,
					effectiveProfile: indexStatus?.effectiveProfile || "lean",
					mode: formatted.mode,
					requestedMode,
					truncated: formatted.truncated,
					visibleRanges: formatted.visibleRanges,
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
	}));
}
