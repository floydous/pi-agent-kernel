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

interface PreparedFileEdit {
	resolvedPath: string;
	relPath: string;
	item: any;
	isAnchorMode: boolean;
	hasSingleAnchor: boolean;
	hasSingleBlock: boolean;
	hasMultiBlock: boolean;
	searchBlocks: string[];
	targetRanges: EvidenceRange[];
	anchorBlocks: SmartAnchorEditBlock[];
	anchorPreflight?: ReturnType<typeof preflightSmartAnchorEdits>;
}

function preflightFileEdit(
	item: any,
	ctx: any,
	deps: SessionDeps,
	benchmarkMethod: string | undefined,
): { error?: string; prepared?: PreparedFileEdit } {
	if (!item || typeof item !== "object" || !item.path) {
		return { error: `[EDIT ERROR] Missing required 'path' parameter or malformed argument payload.` };
	}
	const resolvedPath = resolveUserPath(item.path, ctx.cwd);
	const relPath = path.relative(ctx.cwd, resolvedPath) || item.path;

	if (!fs.existsSync(resolvedPath)) {
		return { error: `[EDIT FAILED] File not found: '${item.path}'.` };
	}

	let edits = item.edits;
	if (Array.isArray(edits)) {
		edits = edits.map((e: any) => {
			if (!e || typeof e !== "object") return e;
			const search = e.search ?? e.oldText ?? e.old_text ?? e.old;
			const replace = e.replace ?? e.newText ?? e.new_text ?? e.new;
			return { ...e, search, replace };
		});
	}
	const singleSearch = item.search ?? item.oldText ?? item.old_text ?? item.old;
	const singleReplace = item.replace ?? item.newText ?? item.new_text ?? item.new;

	const hasSingleAnchor =
		(item.pos !== undefined || item.start_line !== undefined) &&
		Array.isArray(item.lines);
	const hasAnchorEdits =
		Array.isArray(edits) &&
		edits.length > 0 &&
		edits.some(
			(e: any) =>
				e &&
				(e.pos !== undefined ||
					e.start_line !== undefined ||
					(Array.isArray(e.lines) && typeof e.search !== "string")),
		);
	const isAnchorMode = hasSingleAnchor || hasAnchorEdits;
	const hasSingleBlock = typeof singleSearch === "string" && typeof singleReplace === "string";
	const hasMultiBlock = Array.isArray(edits) && edits.length > 0;

	if (benchmarkMethod === "adaptive" && !isAnchorMode && !hasSingleBlock) {
		return { error: `[EDIT ERROR] Adaptive mode requires search/replace or a numeric/hashed line range in '${relPath}'.` };
	}

	if (!isAnchorMode && !hasSingleBlock && !hasMultiBlock) {
		return { error: `[EDIT ERROR] Must provide either smart anchors ('pos' and 'lines', or 'edits' with anchors) or 'search' and 'replace' blocks for '${relPath}'.` };
	}

	const searchBlocks: string[] = [];
	const targetRanges: EvidenceRange[] = [];
	let anchorBlocks: SmartAnchorEditBlock[] = [];
	let anchorPreflight: ReturnType<typeof preflightSmartAnchorEdits> | undefined;

	if (isAnchorMode) {
		if (hasSingleAnchor) {
			anchorBlocks = [
				{
					pos: item.pos ?? item.start_line,
					end: item.end ?? item.end_line,
					lines: item.lines,
				},
			];
		} else {
			anchorBlocks = edits;
		}

		let fileContent: string;
		try {
			fileContent = fs.readFileSync(resolvedPath, "utf8");
		} catch (err: any) {
			return { error: `[EDIT ERROR] Unable to read '${item.path}': ${err.message}` };
		}

		anchorPreflight = preflightSmartAnchorEdits(fileContent, anchorBlocks);
		if (!anchorPreflight.success) {
			return { error: anchorPreflight.error || `[EDIT FAILED] Invalid anchor edit in '${relPath}'.` };
		}
		if (anchorPreflight.targetRanges) {
			targetRanges.push(...anchorPreflight.targetRanges);
		}
	} else if (hasSingleBlock) {
		searchBlocks.push(singleSearch);
		const singleOpt = {
			startLine: item.start_line,
			endLine: item.end_line,
			lineHint: item.line_hint,
		};
		const preflight = preflightSurgicalPatchBlock(resolvedPath, singleSearch, singleOpt);
		if (!preflight.success) {
			if (preflight.isAmbiguous) {
				return {
					error: `[EDIT FAILED] Ambiguous Search Block in '${relPath}': ${preflight.error} Please provide more surrounding context lines to make the match unique.`,
				};
			}
			return {
				error: `[EDIT FAILED] Search Block Not Found in '${relPath}'. Check line context and try again.`,
			};
		}
		if (preflight.targetRange) targetRanges.push(preflight.targetRange);
	} else {
		for (let i = 0; i < edits.length; i++) {
			const block = edits[i];
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
						error: `[EDIT FAILED] Block ${i + 1}/${edits.length} is ambiguous in '${relPath}': ${preflight.error} Please provide more surrounding context lines.`,
					};
				}
				return {
					error: `[EDIT FAILED] Block ${i + 1}/${edits.length} not found in '${relPath}'. Check line context and try again.`,
				};
			}
			if (preflight.targetRange) targetRanges.push(preflight.targetRange);
		}
	}

	const config = deps.getConfig?.(ctx.cwd) ?? loadKernelConfig(ctx.cwd);
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
		return { error: epistemicCheck.reason || `[ERROR] Epistemic read pre-condition failed for '${relPath}'.` };
	}

	return {
		prepared: {
			resolvedPath,
			relPath,
			item: { ...item, search: singleSearch, replace: singleReplace, edits },
			isAnchorMode,
			hasSingleAnchor,
			hasSingleBlock,
			hasMultiBlock,
			searchBlocks,
			targetRanges,
			anchorBlocks,
			anchorPreflight,
		},
	};
}

async function applyPreparedEdit(
	prepared: PreparedFileEdit,
	ctx: any,
	deps: SessionDeps,
): Promise<{ success: boolean; error?: string; verification?: any; strategy?: string; statusText?: string }> {
	const { resolvedPath, relPath, item, isAnchorMode, hasSingleBlock, hasMultiBlock, anchorBlocks, anchorPreflight, targetRanges } = prepared;
	let patchRes: ReturnType<typeof applySurgicalPatch>;
	if (isAnchorMode) {
		patchRes = applySmartAnchorEdits(resolvedPath, anchorBlocks);
	} else if (hasMultiBlock) {
		patchRes = applyMultiBlockPatch(resolvedPath, item.edits);
	} else if (hasSingleBlock) {
		const singleOpt = {
			startLine: item.start_line,
			endLine: item.end_line,
			lineHint: item.line_hint,
		};
		patchRes = applySurgicalPatch(resolvedPath, item.search, item.replace, singleOpt);
	} else {
		return { success: false, error: `[EDIT ERROR] Must provide either smart anchors or 'search' and 'replace' strings.` };
	}

	if (!patchRes.success) {
		return { success: false, error: renderEditFailure(patchRes.error || "patch failed") };
	}

	let diskContent: string;
	try {
		diskContent = fs.readFileSync(resolvedPath, "utf8");
	} catch {
		diskContent = "";
	}

	let deltaLines = 0;
	if (isAnchorMode && anchorPreflight?.resolvedSpans) {
		for (const span of anchorPreflight.resolvedSpans) {
			const deletedCount = span.endLine - span.startLine + 1;
			deltaLines += span.replacementLines.length - deletedCount;
		}
	} else if (hasSingleBlock) {
		const searchLines = item.search.replace(/\r\n/g, "\n").split("\n").length;
		const replaceLines = item.replace.replace(/\r\n/g, "\n").split("\n").length;
		deltaLines = replaceLines - searchLines;
	} else if (hasMultiBlock) {
		for (const block of item.edits) {
			if (block && typeof block.search === "string" && typeof block.replace === "string") {
				const sLines = block.search.replace(/\r\n/g, "\n").split("\n").length;
				const rLines = block.replace.replace(/\r\n/g, "\n").split("\n").length;
				deltaLines += (rLines - sLines);
			}
		}
	}

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

	deps.invalidateSearchFile?.(ctx.cwd, resolvedPath);

	const readyLsp = LspManager.getInstance().getReadyClientForFile(resolvedPath, ctx.cwd);
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

	const statusText = renderPostEditVerification(verification, undefined, relPath);
	return {
		success: verification.syntax.state !== "failed",
		verification,
		strategy: patchRes.strategy,
		statusText,
	};
}

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
							path: Type.Optional(Type.String({ description: "Path to file to edit" })),
							search: Type.Optional(Type.String({ description: "Exact block to replace" })),
							replace: Type.Optional(Type.String({ description: "Replacement text" })),
							line_hint: Type.Optional(Type.Number({ description: "Line hint for disambiguation" })),
							edits: Type.Optional(
								Type.Array(
									Type.Object(
										{
											search: Type.Optional(Type.String()),
											replace: Type.Optional(Type.String()),
											line_hint: Type.Optional(Type.Number()),
										},
										{ additionalProperties: true },
									),
									{ description: "Targeted replacements" },
								),
							),
							files: Type.Optional(
								Type.Array(
									Type.Object(
										{
											path: Type.String(),
											search: Type.Optional(Type.String()),
											replace: Type.Optional(Type.String()),
											line_hint: Type.Optional(Type.Number()),
											edits: Type.Optional(Type.Array(Type.Any())),
										},
										{ additionalProperties: true },
									),
									{ description: "Multi-file edits" },
								),
							),
						}, { additionalProperties: true });
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
							? "Edit code with search/replace or line range; use search first."
						: "Edit code with exact search/replace blocks (optional line_hint), multi-block 'edits', or multi-file 'files'. Auto-heals syntax.",
		promptSnippet: "Edit code using search/replace (optional line_hint), multi-block 'edits', or multi-file 'files'",
		renderShell: "default",
		parameters: editToolParameters,
		async execute(
			_toolCallId: string,
			params: any,
			_signal: any,
			onUpdate: any,
			ctx: any,
		): Promise<any> {
			// Check for multi-file payload
			const fileEdits: any[] = [];
			if (params && typeof params === "object") {
				if (Array.isArray(params.files) && params.files.length > 0) {
					for (const f of params.files) {
						if (f && typeof f === "object" && typeof f.path === "string") {
							fileEdits.push(f);
						}
					}
				} else if (Array.isArray(params.edits) && params.edits.length > 0 && params.edits.some((e: any) => e && typeof e.path === "string")) {
					for (const e of params.edits) {
						if (e && typeof e === "object" && typeof e.path === "string") {
							fileEdits.push(e);
						}
					}
				}
			}

			// Multi-file atomic execution
			if (fileEdits.length > 0) {
				// Check for duplicate canonical paths
				const seenPaths = new Set<string>();
				for (const item of fileEdits) {
					if (!item || typeof item !== "object" || !item.path) {
						return { content: [{ type: "text", text: "[EDIT ERROR] Malformed file edit entry." }], isError: true };
					}
					const canonical = resolveUserPath(item.path, ctx.cwd);
					if (seenPaths.has(canonical)) {
						return {
							content: [{ type: "text", text: `[EDIT ERROR] Duplicate target path in multi-file edit: '${item.path}'.` }],
							isError: true,
						};
					}
					seenPaths.add(canonical);
				}

				onUpdate?.({
					content: [{ type: "text", text: `Preflighting ${fileEdits.length} file edits...` }],
				});

				// Step 1: Preflight ALL files atomically
				const preparedList: PreparedFileEdit[] = [];
				for (const item of fileEdits) {
					const preflight = preflightFileEdit(item, ctx, deps, benchmarkMethod);
					if (preflight.error || !preflight.prepared) {
						return {
							content: [{ type: "text", text: preflight.error || "[EDIT FAILED] Preflight check failed." }],
							isError: true,
						};
					}
					preparedList.push(preflight.prepared);
				}

				// Step 2: Backup snapshots of all files for rollback
				const originalSnapshots = new Map<string, string>();
				for (const prep of preparedList) {
					try {
						originalSnapshots.set(prep.resolvedPath, fs.readFileSync(prep.resolvedPath, "utf8"));
					} catch (err: any) {
						return {
							content: [{ type: "text", text: `[EDIT FAILED] Unable to snapshot '${prep.relPath}' for atomic write: ${err.message}` }],
							isError: true,
						};
					}
				}

				// Step 3: Apply mutations with rollback guard
				onUpdate?.({
					content: [{ type: "text", text: `Applying edits to ${preparedList.length} files...` }],
				});

				const outcomes: any[] = [];
				const mutatedPaths: string[] = [];
				let failureEncountered = false;
				let failureReason = "";

				for (const prepared of preparedList) {
					try {
						const outcome = await applyPreparedEdit(prepared, ctx, deps);
						outcomes.push(outcome);
						mutatedPaths.push(prepared.resolvedPath);
						if (!outcome.success) {
							failureEncountered = true;
							failureReason = outcome.error || outcome.statusText || "Verification failed";
							break;
						}
					} catch (writeErr: any) {
						failureEncountered = true;
						failureReason = writeErr.message;
						break;
					}
				}

				// Rollback if any write or verification failed
				if (failureEncountered) {
					for (const mutated of mutatedPaths) {
						const backup = originalSnapshots.get(mutated);
						if (backup !== undefined) {
							try {
								fs.writeFileSync(mutated, backup, "utf8");
							} catch (rbErr) {
								kernelDebug(rbErr);
							}
						}
					}
					return {
						content: [{ type: "text", text: `[EDIT FAILED - ROLLED BACK] Multi-file edit aborted and rolled back: ${failureReason}` }],
						isError: true,
					};
				}

				const affectedPaths = preparedList.map((p) => p.relPath);
				return {
					content: [{ type: "text", text: `Successfully applied edits to ${affectedPaths.length} files: ${affectedPaths.join(", ")}.` }],
					details: { multiFile: true, count: affectedPaths.length, files: affectedPaths },
				};
			}

			// Single-file execution
			const preflight = preflightFileEdit(params, ctx, deps, benchmarkMethod);
			if (preflight.error || !preflight.prepared) {
				return {
					content: [{ type: "text", text: preflight.error || "[EDIT FAILED] Preflight check failed." }],
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Editing ${preflight.prepared.relPath}...` }],
			});

			const outcome = await applyPreparedEdit(preflight.prepared, ctx, deps);
			if (!outcome.success && outcome.error) {
				return {
					content: [{ type: "text", text: outcome.error }],
					details: { success: false },
					isError: true,
				};
			}

			return {
				content: outcome.statusText ? [{ type: "text", text: outcome.statusText }] : [],
				details: {
					strategy: outcome.strategy,
					verification: outcome.verification,
					success: outcome.verification?.syntax?.state === "clean",
				},
				isError:
					outcome.verification?.syntax?.state === "failed" ||
					outcome.verification?.diagnostic?.findings?.some(
						(finding: any) => finding.severity === "error" || !finding.severity,
					),
			};
		},
		renderCall(args: any, theme: any, context: any) {
			const fileEdits: string[] = [];
			if (Array.isArray(args?.files)) {
				for (const f of args.files) {
					if (f?.path) fileEdits.push(path.relative(context.cwd, resolveUserPath(f.path, context.cwd)) || f.path);
				}
			} else if (Array.isArray(args?.edits) && args.edits.some((e: any) => e?.path)) {
				for (const e of args.edits) {
					if (e?.path) fileEdits.push(path.relative(context.cwd, resolveUserPath(e.path, context.cwd)) || e.path);
				}
			}
			if (fileEdits.length > 0) {
				return makeOutputText(
					`${theme.fg("toolTitle", theme.bold("edit"))} [${theme.fg("accent", fileEdits.join(", "))}]`,
				);
			}
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
