import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import * as path from "node:path";
import { applySurgicalPatch, applyMultiBlockPatch } from "../editing/patch";
import { checkSyntax, autoCommitFile } from "../editing/git-verify";
import { globalEpistemicGuard } from "../safety/epistemic_guard";
import type { SessionDeps } from "./context";

/** Extracted from index.ts — registers the `edit` tool. */
export function registerEditTool(pi: ExtensionAPI, deps: SessionDeps): void {
	// 7. Tool: `edit` (Unified Surgical Diff & Multi-Block Editor - Replaces stock edit tool)
	const editToolDefinition: any = {
		name: "edit",
		label: "Surgical Code Editor",
		description:
			"Surgically edit code using search/replace blocks with multi-strategy fuzzy matching, automatic syntax verification, and atomic git commit tracking. Supports single search/replace and multi-block edits.",
		promptSnippet:
			"Surgically edit code using search/replace blocks with automatic syntax verification and git commits",
		renderShell: "default",
		parameters: Type.Object({
			path: Type.String({
				description: "File path (absolute or relative) to the file to edit",
			}),
			search: Type.Optional(
				Type.String({
					description: "Exact or near-exact lines of code to replace (single block)",
				}),
			),
			replace: Type.Optional(
				Type.String({ description: "New replacement code lines (single block)" }),
			),
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						search: Type.String({ description: "Search block" }),
						replace: Type.String({ description: "Replacement block" }),
					}),
					{
						description:
							"Optional list of multiple disjoint search/replace blocks to apply atomically",
					},
				),
			),
			commit_message: Type.Optional(
				Type.String({ description: "Optional git commit message for this edit" }),
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
						{
							type: "text",
							text: `[EDIT ERROR] Missing required 'path' parameter or malformed argument payload.`,
						},
					],
					isError: true,
				};
			}

			const resolvedPath = path.isAbsolute(params.path)
				? params.path
				: path.resolve(ctx.cwd, params.path);

			// 1. Read-Before-Write Epistemic Guard Check
			const epistemicCheck = globalEpistemicGuard.checkReadPrecondition(
				resolvedPath,
				"edit",
				deps.getSessionId(ctx),
			);
			if (!epistemicCheck.allowed) {
				return {
					content: [
						{
							type: "text",
							text:
								epistemicCheck.reason || "[ERROR] Epistemic read pre-condition failed.",
						},
					],
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Editing ${params.path}...` }],
			});

			let patchRes;
			if (params.edits && Array.isArray(params.edits) && params.edits.length > 0) {
				patchRes = applyMultiBlockPatch(resolvedPath, params.edits);
			} else if (params.search !== undefined && params.replace !== undefined) {
				patchRes = applySurgicalPatch(resolvedPath, params.search, params.replace);
			} else {
				return {
					content: [
						{
							type: "text",
							text: `[EDIT ERROR] Must provide either 'search' and 'replace' strings, or an 'edits' array of search/replace blocks.`,
						},
					],
					isError: true,
				};
			}

			if (!patchRes.success) {
				return {
					content: [{ type: "text", text: `[EDIT FAILED] ${patchRes.error}` }],
					details: { error: patchRes.error, success: false },
					isError: true,
				};
			}

			// Post-edit syntax verification
			const syntaxRes = checkSyntax(resolvedPath);
			let statusText = `[EDIT SUCCESS] Applied via ${patchRes.strategy} strategy.\n\n${patchRes.diffOutput || ""}`;

			if (!syntaxRes.valid) {
				statusText += `\n\n[SYNTAX WARNING] ${syntaxRes.error}\nPlease fix the syntax error immediately.`;
				return {
					content: [{ type: "text", text: statusText }],
					details: {
						strategy: patchRes.strategy,
						syntaxError: syntaxRes.error,
						success: true,
					},
					isError: false,
				};
			}

			// Auto-commit if git repo
			const committed = autoCommitFile(
				ctx.cwd,
				resolvedPath,
				params.commit_message,
			);
			if (committed) {
				statusText += "\n[GIT] Changes automatically committed to git.";
			}

			return {
				content: [{ type: "text", text: statusText }],
				details: { strategy: patchRes.strategy, committed, success: true },
			};
		},
		renderCall(args: any, theme: any, context: any) {
			const rawPath = args?.path || "";
			const relPath = rawPath
				? path.relative(context.cwd, rawPath) || rawPath
				: "";
			return makeOutputText(
				`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", relPath)}`,
			);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (context.isError) {
				const errMsg =
					result.content?.find((c: any) => c.type === "text")?.text || "Edit failed";
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

	pi.registerTool(editToolDefinition);
}
