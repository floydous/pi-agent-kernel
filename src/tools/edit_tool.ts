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
	preflightSurgicalPatchBlock,
} from "../editing/patch";
import {
	applySmartAnchorEdits,
	preflightSmartAnchorEdits,
	type SmartAnchorEditBlock,
} from "../editing/smart_anchor";
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
	// 7. Tool: `edit` (Unified Surgical Diff, Smart Anchor, & Multi-Block Editor - Replaces stock edit tool)
	const benchmarkMethod = process.env.PI_EDIT_METHOD?.toLowerCase();
	const editToolParameters = benchmarkMethod === "line-range"
		? Type.Object({
				path: Type.String({ description: "File path to edit" }),
				start_line: Type.Number({ description: "First 1-based line to replace" }),
				end_line: Type.Optional(Type.Number({ description: "Last 1-based line to replace, inclusive" })),
				lines: Type.Array(Type.String(), { description: "Replacement lines (empty to delete)" }),
			})
		: benchmarkMethod === "hash-anchor"
			? Type.Object({
					path: Type.String({ description: "File path to edit" }),
					pos: Type.String({ description: "Start anchor copied from read output, e.g. '288#ZH'" }),
					end: Type.Optional(Type.String({ description: "End anchor copied from read output, e.g. '294#VN'" })),
					lines: Type.Array(Type.String(), { description: "Replacement lines (empty to delete)" }),
				})
				: benchmarkMethod === "search-replace"
				? Type.Object({
						path: Type.String({ description: "File path to edit" }),
						search: Type.String({ description: "Unique exact source block to replace" }),
						replace: Type.String({ description: "Replacement source block" }),
					})
				: benchmarkMethod === "adaptive"
					? Type.Object({
							path: Type.String({ description: "File path to edit" }),
							search: Type.Optional(Type.String({ description: "Unique exact source block to replace" })),
							replace: Type.Optional(Type.String({ description: "Replacement source block" })),
							start_line: Type.Optional(Type.Number({ description: "First 1-based line to replace" })),
							end_line: Type.Optional(Type.Number({ description: "Last 1-based line to replace, inclusive" })),
							pos: Type.Optional(Type.String({ description: "LINE#HASH anchor copied from read output" })),
							end: Type.Optional(Type.String({ description: "Ending LINE#HASH anchor" })),
							lines: Type.Optional(Type.Array(Type.String(), { description: "Replacement lines (empty to delete)" })),
						})
					: Type.Object({
							path: Type.String({ description: "File path to edit" }),
							search: Type.Optional(Type.String({ description: "Search block to find and replace" })),
							replace: Type.Optional(Type.String({ description: "Replacement block" })),
							line_hint: Type.Optional(Type.Number({ description: "Line hint" })),
							start_line: Type.Optional(Type.Number()),
							end_line: Type.Optional(Type.Number()),
							lines: Type.Optional(Type.Array(Type.String(), { description: "Replacement lines" })),
							pos: Type.Optional(Type.String({ description: "Start anchor or line number" })),
							end: Type.Optional(Type.String({ description: "End anchor or line number" })),
							edits: Type.Optional(
								Type.Array(
									Type.Object({
										search: Type.Optional(Type.String()),
										replace: Type.Optional(Type.String()),
										line_hint: Type.Optional(Type.Number()),
										start_line: Type.Optional(Type.Number()),
										end_line: Type.Optional(Type.Number()),
										pos: Type.Optional(Type.String()),
										end: Type.Optional(Type.String()),
										lines: Type.Optional(Type.Array(Type.String())),
									}),
								),
							),
						});
	const editToolDefinition: any = {
		name: "edit",
		label: "Code Editor",
		description:
			benchmarkMethod === "line-range"
				? "Edit code with numeric line ranges only: start_line, optional end_line, and replacement lines."
				: benchmarkMethod === "hash-anchor"
					? "Edit code with LINE#HASH anchors only, copied from read output."
					: benchmarkMethod === "search-replace"
						? "Edit code with a unique exact search block and replacement block only."
						: benchmarkMethod === "adaptive"
							? "Edit code with a unique search/replace block or numeric line range; use search first and line range if needed."
						: "Edit code using search/replace blocks (with optional line_hint) or line ranges with pre-write syntax verification.",
		promptSnippet: "Edit code using the selected target method",
		renderShell: "default",
		parameters: editToolParameters,
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
			const searchBlocks: string[] = [];
			const targetRanges: EvidenceRange[] = [];

			const hasSingleAnchor =
				(params.pos !== undefined || params.start_line !== undefined) &&
				Array.isArray(params.lines);
			const hasAnchorEdits =
				Array.isArray(params.edits) &&
				params.edits.length > 0 &&
				params.edits.some(
					(e: any) =>
						e &&
						(e.pos !== undefined ||
							e.start_line !== undefined ||
							(Array.isArray(e.lines) && typeof e.search !== "string")),
				);
			const isAnchorMode = hasSingleAnchor || hasAnchorEdits;

			const hasSingleBlock =
				typeof params.search === "string" && typeof params.replace === "string";
			const hasMultiBlock = Array.isArray(params.edits) && params.edits.length > 0;

			if (benchmarkMethod === "adaptive" && !isAnchorMode && !hasSingleBlock) {
				return {
					content: [{ type: "text", text: "[EDIT ERROR] Adaptive mode requires search/replace or a numeric/hashed line range." }],
					isError: true,
				};
			}

			if (!isAnchorMode && !hasSingleBlock && !hasMultiBlock) {
				return {
					content: [
						{
							type: "text",
							text: "[EDIT ERROR] Must provide either smart anchors ('pos' and 'lines', or 'edits' with anchors) or 'search' and 'replace' blocks.",
						},
					],
					isError: true,
				};
			}

			let anchorPreflight: ReturnType<typeof preflightSmartAnchorEdits> | undefined;
			let anchorBlocks: SmartAnchorEditBlock[] = [];

			if (isAnchorMode) {
				if (hasSingleAnchor) {
					anchorBlocks = [
						{
							pos: params.pos ?? params.start_line,
							end: params.end ?? params.end_line,
							lines: params.lines,
						},
					];
				} else {
					anchorBlocks = params.edits;
				}

				let fileContent: string;
				try {
					fileContent = fs.readFileSync(resolvedPath, "utf8");
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `[EDIT ERROR] Unable to read '${params.path}': ${err.message}` }],
						isError: true,
					};
				}

				anchorPreflight = preflightSmartAnchorEdits(fileContent, anchorBlocks);
				if (!anchorPreflight.success) {
					return {
						content: [{ type: "text", text: anchorPreflight.error || "[EDIT FAILED] Invalid anchor edit." }],
						isError: true,
					};
				}
				if (anchorPreflight.targetRanges) {
					targetRanges.push(...anchorPreflight.targetRanges);
				}
			} else if (hasSingleBlock) {
				searchBlocks.push(params.search);
				const singleOpt = {
					startLine: params.start_line,
					endLine: params.end_line,
					lineHint: params.line_hint,
				};
				const preflight = preflightSurgicalPatchBlock(resolvedPath, params.search, singleOpt);
				if (!preflight.success) {
					if (preflight.isAmbiguous) {
						return {
							content: [
								{
									type: "text",
									text: `[EDIT FAILED] Ambiguous Search Block: ${preflight.error} Please provide more surrounding context lines to make the match unique.`,
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `[EDIT FAILED] Search Block Not Found in '${params.path}'. Check line context and try again.`,
							},
						],
						isError: true,
					};
				}
				if (preflight.targetRange) targetRanges.push(preflight.targetRange);
			} else {
				// Multi-block patching reports ranges after applying blocks; preflight
				// uses the original file's coordinates for each search block.
				for (let i = 0; i < params.edits.length; i++) {
					const block = params.edits[i];
					if (!block || typeof block.search !== "string") continue;
					searchBlocks.push(block.search);
					const blockOpt = {
						startLine: block.start_line,
						endLine: block.end_line,
						lineHint: block.line_hint,
					};
					const preflight = preflightSurgicalPatchBlock(resolvedPath, block.search, blockOpt);
					if (!preflight.success) {
						if (preflight.isAmbiguous) {
							return {
								content: [
									{
										type: "text",
										text: `[EDIT FAILED] Block ${i + 1}/${params.edits.length} is ambiguous: ${preflight.error} Please provide more surrounding context lines.`,
									},
								],
								isError: true,
							};
						}
						return {
							content: [
								{
									type: "text",
									text: `[EDIT FAILED] Block ${i + 1}/${params.edits.length} not found in '${params.path}'. Check line context and try again.`,
								},
							],
							isError: true,
						};
					}
					if (preflight.targetRange) targetRanges.push(preflight.targetRange);
				}
			}
			const epistemicCheck = globalEpistemicGuard.checkReadPrecondition(
				resolvedPath,
				"edit",
				deps.getSessionId(ctx),
				ctx.cwd,
				config?.safety?.enable_epistemic_guard ?? true,
				targetRanges,
				searchBlocks,
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
			if (isAnchorMode) {
				patchRes = applySmartAnchorEdits(resolvedPath, anchorBlocks);
			} else if (hasMultiBlock) {
				patchRes = applyMultiBlockPatch(resolvedPath, params.edits);
			} else if (hasSingleBlock) {
				const singleOpt = {
					startLine: params.start_line,
					endLine: params.end_line,
					lineHint: params.line_hint,
				};
				patchRes = applySurgicalPatch(resolvedPath, params.search, params.replace, singleOpt);
			} else {
				return {
					content: [{ type: "text", text: `[EDIT ERROR] Must provide either smart anchors or 'search' and 'replace' strings.` }],
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
			if (isAnchorMode && anchorPreflight?.resolvedSpans) {
				for (const span of anchorPreflight.resolvedSpans) {
					const deletedCount = span.endLine - span.startLine + 1;
					deltaLines += span.replacementLines.length - deletedCount;
				}
			} else if (hasSingleBlock) {
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
									column: finding.range.start.character + 1,
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
