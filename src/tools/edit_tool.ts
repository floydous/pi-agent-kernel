import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import * as path from "node:path";
import * as fs from "node:fs";
import { kernelDebug } from "../safety/kernel_debug";
import {
	applySurgicalPatch,
	applyMultiBlockPatch,
	findSurgicalPatchTargetRange,
} from "../editing/patch";
import type { EvidenceRange } from "../safety/epistemic_guard";
import {
	renderEditFailure,
	renderPostEditVerification,
	verifyEditedFile,
} from "../editing/post_edit_verification";
import { LspManager } from "../lsp";
import {
	globalEpistemicGuard,
	resolveUserPath,
} from "../safety/epistemic_guard";
import { loadKernelConfig } from "../config";
import type { SessionDeps } from "./context";

/** Extracted from index.ts — registers the `edit` tool. */
export function registerEditTool(pi: ExtensionAPI, deps: SessionDeps): void {
	// 7. Tool: `edit` (Unified Surgical Diff & Multi-Block Editor - Replaces stock edit tool)
	const editToolDefinition: any = {
		name: "edit",
		label: "Surgical Code Editor",
		description:
			"Surgically edit code using search/replace blocks with multi-strategy fuzzy matching and automatic syntax verification. Supports single search/replace and multi-block edits.",
		promptSnippet:
			"Surgically edit code using search/replace blocks with automatic syntax verification",
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

			const resolvedPath = resolveUserPath(params.path, ctx.cwd);

			// 1. Read-Before-Write Epistemic Guard Check
			const config = deps.getConfig?.(ctx.cwd) ?? loadKernelConfig(ctx.cwd);
			const targetRanges: EvidenceRange[] = [];
			const hasSingleBlock =
				typeof params.search === "string" && typeof params.replace === "string";
			const hasMultiBlock = Array.isArray(params.edits) && params.edits.length > 0;
			if (!hasSingleBlock && !hasMultiBlock) {
				return {
					content: [
						{
							type: "text",
							text: "[EDIT ERROR] Must provide either 'search' and 'replace' strings, or an 'edits' array of search/replace blocks.",
						},
					],
					isError: true,
				};
			}
			if (hasSingleBlock) {
				const targetRange = findSurgicalPatchTargetRange(resolvedPath, params.search);
				if (targetRange) targetRanges.push(targetRange);
			} else {
				// Multi-block patching reports ranges after applying blocks; preflight
				// uses the original file's coordinates for each search block.
				for (const block of params.edits) {
					if (!block || typeof block.search !== "string") continue;
					const targetRange = findSurgicalPatchTargetRange(resolvedPath, block.search);
					if (targetRange) targetRanges.push(targetRange);
				}
			}
			const epistemicCheck = globalEpistemicGuard.checkReadPrecondition(
				resolvedPath,
				"edit",
				deps.getSessionId(ctx),
				ctx.cwd,
				config.safety.enable_epistemic_guard,
				targetRanges,
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

			let patchRes: ReturnType<typeof applySurgicalPatch>;
			if (hasMultiBlock) {
				patchRes = applyMultiBlockPatch(resolvedPath, params.edits);
			} else if (hasSingleBlock) {
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
					content: [
						{
							type: "text",
							text: renderEditFailure(patchRes.error || "patch failed"),
						},
					],
					details: { error: patchRes.error, success: false },
					isError: true,
				};
			}

			// Read back the exact content as written to disk
			let diskContent: string;
			try {
				diskContent = fs.readFileSync(resolvedPath, "utf8");
			} catch {
				diskContent = "";
			}

			// Calculate net line count difference from the edit blocks
			let deltaLines = 0;
			if (hasSingleBlock) {
				const searchLines = params.search.replace(/\r\n/g, "\n").split("\n").length;
				const replaceLines = params.replace.replace(/\r\n/g, "\n").split("\n").length;
				deltaLines = replaceLines - searchLines;
			} else if (hasMultiBlock) {
				for (const block of params.edits) {
					if (block && typeof block.search === "string" && typeof block.replace === "string") {
						const sLines = block.search.replace(/\r\n/g, "\n").split("\n").length;
						const rLines = block.replace.replace(/\r\n/g, "\n").split("\n").length;
						deltaLines += (rLines - sLines);
					}
				}
			}

			// Update the Epistemic Guard ledger with the freshly written file snapshot.
			// This maintains authorization for subsequent edits in the same session without
			// forcing redundant reads, while preserving strict protection against external file drift.
			globalEpistemicGuard.recordFileMutation(
				resolvedPath,
				deps.getSessionId(ctx),
				ctx.cwd,
				diskContent,
				{
					targetRanges: patchRes.targetRanges || targetRanges,
					deltaLines,
				},
			);

			// The file was mutated even when post-edit diagnostics later report a
			// problem; never leave the search index serving its pre-edit content.
			deps.invalidateSearchFile?.(ctx.cwd, resolvedPath);

			// Verify locally first. Reuse an already-ready LSP client only; edit
			// verification must not spawn a server or trigger broad analysis.
			const readyLsp = LspManager.getInstance().getReadyClientForFile(
				resolvedPath,
				ctx.cwd,
			);

			// Synchronize LSP client in-memory buffer with the newly patched file
			if (readyLsp && readyLsp.getState() === "ready") {
				try {
					await readyLsp.changeDocument(resolvedPath, diskContent);
					await readyLsp.saveDocument(resolvedPath, diskContent);
				} catch (err) {
					kernelDebug(err);
				}
			}
			const verification = await verifyEditedFile(
				resolvedPath,
				readyLsp
					? async () => {
							const result = await readyLsp.getDiagnosticsResult(resolvedPath);
							return {
								state: result.status,
								findings: result.diagnostics.map((finding) => ({
									line: finding.range.start.line + 1,
									message: finding.message,
									severity:
										finding.severity === 1
											? ("error" as const)
											: finding.severity === 2
												? ("warning" as const)
												: ("info" as const),
								})),
							};
						}
					: undefined,
			);

			const statusText = renderPostEditVerification(verification);
			return {
				content: statusText ? [{ type: "text", text: statusText }] : [],
				details: {
					strategy: patchRes.strategy,
					verification,
					success: verification.syntax.state === "clean",
				},
				isError:
					verification.syntax.state === "failed" ||
					verification.diagnostic.findings.some(
						(finding) => finding.severity === "error" || !finding.severity,
					),
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
