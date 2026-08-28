import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import { computeRepoMap } from "../retrieval/repomap";

/** Extracted from index.ts — registers the `repo_map` tool. */
export function registerRepoMapTool(pi: ExtensionAPI): void {
	// 4. Tool: `get_repo_map` (Tree-sitter PageRank Map)
	pi.registerTool({
		name: "get_repo_map",
		label: "Get Repository Map",
		description:
			"Get a concise, PageRank-ranked AST map of classes, functions, and symbols across the entire repository (~1k tokens).",
		promptSnippet: "Inspect repository AST symbol graph and signatures",
		renderShell: "default",
		parameters: Type.Object({
			budget_tokens: Type.Optional(
				Type.Number({ description: "Target token budget (default: 1024)" }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			ctx: any,
		) {
			const budget = params.budget_tokens || 1024;
			const repoMap = computeRepoMap(ctx.cwd, budget);
			return {
				content: [{ type: "text", text: repoMap }],
				details: { budget, length: repoMap.length },
			};
		},
		renderCall(args: any, theme: any, _context: any) {
			return makeOutputText(
				`${theme.fg("toolTitle", theme.bold("get_repo_map"))} (budget: ${args?.budget_tokens || 1024})`,
			);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (context.isError) {
				const errMsg =
					result.content?.find((c: any) => c.type === "text")?.text ||
					"Repo map failed";
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
