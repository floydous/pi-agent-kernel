import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import { searchAstSymbols } from "../retrieval/ast_search";
import { globalEpistemicGuard } from "../safety/epistemic_guard";
import type { SessionDeps } from "./context";

/** Extracted from index.ts — registers the `ast_search` tool. */
export function registerAstSearchTool(
	pi: ExtensionAPI,
	deps: SessionDeps,
): void {
	// 5. Tool: `ast_search` (Tree-sitter Structural Symbol Search)
	pi.registerTool({
		name: "ast_search",
		label: "Tree-sitter AST Search",
		description:
			"Search symbol declarations (functions, classes, methods, types) by AST structure across the repository. Bypasses comments, strings, and documentation.",
		promptSnippet:
			"Search exact code declarations and signatures via Tree-sitter AST",
		renderShell: "default",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Symbol name or substring to search" }),
			),
			kind: Type.Optional(
				Type.String({
					description:
						"Kind: function | class | method | interface | type | struct | trait | enum | impl | alias | variable | constant",
				}),
			),
			filePattern: Type.Optional(
				Type.String({
					description:
						"Optional normalized relative path substring (e.g. 'src/safety', '.py', 'test')",
				}),
			),
			includeBody: Type.Optional(
				Type.Boolean({
					description:
						"Include a bounded preview of up to 25 symbol lines (default: false); use read_symbol for the complete body",
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
			onUpdate?.({
				content: [
					{ type: "text", text: `Searching AST for "${params.name || "*"}"...` },
				],
			});
			const results = searchAstSymbols(ctx.cwd, {
				name: params.name,
				kind: params.kind,
				filePattern: params.filePattern,
				includeBody: params.includeBody,
			});

			const sessionId = deps.getSessionId(ctx);
			for (const r of results) {
				globalEpistemicGuard.recordFileSearched(r.filePath, sessionId);
			}

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No AST symbols found matching query. (Note: For string literals, error codes, or configs, use 'rg' in bash).`,
						},
					],
					details: { count: 0 },
				};
			}

			const formatted = results.slice(0, 30).map((r) => {
				let str = `[${r.kind.toUpperCase()}] ${r.name} (${r.filePath}:${r.line})\n  Signature: ${r.signature}`;
				if (r.codeBlock) {
					str += `\n  Body:\n${r.codeBlock}`;
				}
				return str;
			});

			return {
				content: [
					{
						type: "text",
						text: `Found ${results.length} AST symbol(s):\n\n${formatted.join("\n\n")}`,
					},
				],
				details: { count: results.length },
			};
		},
		renderCall(args: any, theme: any, _context: any) {
			return makeOutputText(
				`${theme.fg("toolTitle", theme.bold("ast_search"))} ${theme.fg("accent", args?.name || "*")}${args?.kind ? ` [${args.kind}]` : ""}`,
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
