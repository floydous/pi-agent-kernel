import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import * as path from "node:path";
import * as fs from "node:fs";
import {
	LspManager,
	formatDiagnostics,
	formatDefinitions,
	formatReferences,
	formatHover,
	formatDocumentSymbols,
} from "../lsp";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
	searchAstSymbols,
} from "../retrieval/ast_search";
import { checkSyntax } from "../editing/syntax-verify";
import { kernelDebug } from "../safety/kernel_debug";

/** Extracted from index.ts — registers the `lsp` tool. */
export function registerLspTool(pi: ExtensionAPI): void {
	// 8. Tool: `lsp` (Language Server Protocol Symbol Resolution, Definitions, References, & Diagnostics)
	pi.registerTool({
		name: "lsp",
		label: "Language Server Protocol (LSP)",
		description:
			"Query language server for definitions, references, hover docstrings, document symbols, or diagnostics with instant Tree-sitter fallback.",
		promptSnippet:
			"Query LSP for definitions, references, hover type signatures, and workspace diagnostics",
		renderShell: "default",
		parameters: Type.Object({
			action: Type.String({
				enum: [
					"definition",
					"references",
					"hover",
					"document_symbols",
					"diagnostics",
				],
				description:
					"LSP operation: 'definition' | 'references' | 'hover' | 'document_symbols' | 'diagnostics'",
			}),
			path: Type.String({ description: "File path (absolute or relative)" }),
			line: Type.Optional(
				Type.Number({
					description:
						"1-based line number (required for definition, references, hover)",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description: "1-based character/column number (default: 1)",
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
			const action = params.action;
			const targetPath = params.path;
			const absPath = path.isAbsolute(targetPath)
				? targetPath
				: path.resolve(ctx.cwd, targetPath);

			if (!fs.existsSync(absPath)) {
				return {
					content: [
						{ type: "text", text: `[LSP ERROR] File not found: ${targetPath}` },
					],
					isError: true,
				};
			}

			const line0 = Math.max(0, (params.line || 1) - 1);
			const col0 = Math.max(0, (params.character || 1) - 1);

			// Helper: extract identifier / qualified symbol under cursor (supports `foo.bar`, `crate::state::KeyUsage`)
			const getSymbolUnderCursor = (): {
				full: string;
				leaf: string;
				isModule: boolean;
			} => {
				try {
					const fileContent = fs.readFileSync(absPath, "utf8");
					const lines = fileContent.split("\n");
					const lineText = lines[line0] || "";
					const qualifiedWords = Array.from(
						lineText.matchAll(
							/[a-zA-Z_][a-zA-Z0-9_]*(?:(?:::|\.)[a-zA-Z_][a-zA-Z0-9_]*)*/g,
						),
					);

					for (const w of qualifiedWords) {
						if (
							w.index !== undefined &&
							col0 >= w.index &&
							col0 <= w.index + w[0].length
						) {
							const fullExpr = w[0];
							const separator = fullExpr.includes("::") ? "::" : ".";
							const parts = fullExpr.split(separator);

							let currentOffset = w.index;
							for (let idx = 0; idx < parts.length; idx++) {
								const part = parts[idx];
								const partEnd = currentOffset + part.length;
								if (col0 >= currentOffset && col0 <= partEnd) {
									const isModule =
										idx < parts.length - 1 ||
										part === "crate" ||
										part === "super" ||
										part === "self";
									return { full: fullExpr, leaf: part, isModule };
								}
								currentOffset = partEnd + separator.length;
							}
							return {
								full: fullExpr,
								leaf: parts[parts.length - 1],
								isModule: false,
							};
						}
					}
				} catch (e) {
					kernelDebug(e);
				}
				return { full: "", leaf: "", isModule: false };
			};

			onUpdate?.({
				content: [{ type: "text", text: `Querying LSP (${action})...` }],
			});

			const lspMgr = LspManager.getInstance();
			const client = await lspMgr.getClientForFile(absPath, ctx.cwd);

			// If no client available, fall back cleanly to AST intelligence
			if (!client) {
				if (action === "document_symbols") {
					const docSyms = extractDocumentSymbols(absPath);
					if (docSyms.length > 0) {
						const formatted = docSyms
							.map((s) => `• [${s.kind}] ${s.name} (line ${s.line}) - ${s.signature}`)
							.join("\n");
						return {
							content: [
								{
									type: "text",
									text: `[Tree-sitter AST Document Symbols - ${docSyms.length} symbol(s)]\n${formatted}`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `[Tree-sitter AST] No symbols found in ${path.basename(absPath)}.`,
							},
						],
					};
				}

				if (action === "references") {
					const sym = getSymbolUnderCursor();
					const targetSym = sym.leaf || sym.full;
					if (targetSym) {
						const refs = findSymbolReferences(ctx.cwd, targetSym);
						if (refs.length > 0) {
							const formatted = refs
								.map((r) => `  • ${r.filePath}:${r.line}:${r.column}  ${r.lineText}`)
								.join("\n");
							return {
								content: [
									{
										type: "text",
										text: `[Tree-sitter AST References - ${refs.length} match(es) for '${targetSym}']\n${formatted}`,
									},
								],
							};
						}
					}
					return {
						content: [{ type: "text", text: "No references found in workspace." }],
					};
				}

				if (action === "hover") {
					const sym = getSymbolUnderCursor();
					const targetSym = sym.leaf || sym.full;
					if (targetSym) {
						const localHover = extractLocalSymbolHover(
							absPath,
							line0,
							col0,
							targetSym,
						);
						if (localHover) {
							return { content: [{ type: "text", text: localHover }] };
						}
						const astHits = searchAstSymbols(ctx.cwd, {
							name: targetSym,
							exactMatch: true,
							currentFilePath: absPath,
						});
						if (astHits.length > 0) {
							const hit = astHits[0];
							return {
								content: [
									{
										type: "text",
										text: `[Tree-sitter AST Hover - ${hit.kind} ${hit.name}]\n${hit.signature}\nDeclared in ${hit.filePath}:${hit.line}`,
									},
								],
							};
						}
					}
					return {
						content: [
							{
								type: "text",
								text: "No hover information available at this position.",
							},
						],
					};
				}

				if (action === "definition") {
					const sym = getSymbolUnderCursor();
					const targetSym = sym.leaf || sym.full;
					if (targetSym) {
						// 1. Check if targetSym is a module/file in the workspace (e.g. `state` -> `src/state.rs` or `state/mod.rs`)
						const candidates = [
							path.join(ctx.cwd, "src", `${targetSym}.rs`),
							path.join(ctx.cwd, "src", targetSym, "mod.rs"),
							path.join(ctx.cwd, `${targetSym}.rs`),
							path.join(ctx.cwd, "src", `${targetSym}.ts`),
							path.join(ctx.cwd, `${targetSym}.ts`),
							path.join(ctx.cwd, `${targetSym}.py`),
							path.join(path.dirname(absPath), `${targetSym}.rs`),
							path.join(path.dirname(absPath), targetSym, "mod.rs"),
						];
						for (const cand of candidates) {
							if (fs.existsSync(cand) && cand !== absPath) {
								const rel = path.relative(ctx.cwd, cand).replace(/\\/g, "/");
								return {
									content: [
										{
											type: "text",
											text: `[Tree-sitter AST Definition - module '${targetSym}']\n  → [module] ${targetSym} (${rel}:1)\n     Module file in workspace`,
										},
									],
								};
							}
						}

						// 2. Search AST symbol declarations across workspace
						let astHits = searchAstSymbols(ctx.cwd, {
							name: targetSym,
							exactMatch: true,
							currentFilePath: absPath,
						});
						if (astHits.length === 0 && sym.full && sym.full !== targetSym) {
							astHits = searchAstSymbols(ctx.cwd, {
								name: sym.full,
								exactMatch: true,
								currentFilePath: absPath,
							});
						}
						if (astHits.length === 0) {
							astHits = searchAstSymbols(ctx.cwd, {
								name: targetSym,
								exactMatch: false,
								currentFilePath: absPath,
							});
						}
						if (astHits.length === 0 && sym.full && sym.full !== targetSym) {
							astHits = searchAstSymbols(ctx.cwd, {
								name: sym.full,
								exactMatch: false,
								currentFilePath: absPath,
							});
						}
						if (astHits.length > 0) {
							const formatted = astHits
								.slice(0, 5)
								.map((h) => {
									const aliasInfo = h.aliasedFrom
										? `\n     (aliased from '${h.aliasedFrom.originalName}' in ${h.aliasedFrom.module || "workspace"})`
										: "";
									return `  → [${h.kind}] ${h.name} (${h.filePath}:${h.line})\n     Signature: ${h.signature}${aliasInfo}`;
								})
								.join("\n");
							return {
								content: [
									{
										type: "text",
										text: `[Tree-sitter AST Definition - ${astHits.length} match(es) for '${targetSym}']\n${formatted}`,
									},
								],
							};
						}
					}
					return {
						content: [{ type: "text", text: "Definition not found." }],
					};
				}

				if (action === "diagnostics") {
					const syn = checkSyntax(absPath);
					if (!syn.valid) {
						return {
							content: [
								{
									type: "text",
									text: `Diagnostics for ${path.relative(ctx.cwd, absPath)}:\n  1:1 [ERROR] Syntax Error: ${syn.error}`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No diagnostics reported for ${path.relative(ctx.cwd, absPath)}.`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `[LSP Notice] No installed LSP server found for ${path.basename(absPath)}. Use 'ast_search' or run '/lsp install' to configure an LSP server.`,
						},
					],
				};
			}

			try {
				if (action === "definition") {
					const defs = await client.gotoDefinition(absPath, line0, col0);
					if (defs.length > 0) {
						return {
							content: [{ type: "text", text: formatDefinitions(defs, ctx.cwd) }],
						};
					}
					// Tree-sitter fallback with exact symbol ranking
					const sym = getSymbolUnderCursor();
					const targetSym = sym.leaf || sym.full;
					if (targetSym) {
						let astHits = searchAstSymbols(ctx.cwd, {
							name: targetSym,
							exactMatch: true,
						});
						if (astHits.length === 0 && sym.full && sym.full !== targetSym) {
							astHits = searchAstSymbols(ctx.cwd, {
								name: sym.full,
								exactMatch: true,
							});
						}
						if (astHits.length === 0) {
							astHits = searchAstSymbols(ctx.cwd, {
								name: targetSym,
								exactMatch: false,
							});
						}
						if (astHits.length === 0 && sym.full && sym.full !== targetSym) {
							astHits = searchAstSymbols(ctx.cwd, {
								name: sym.full,
								exactMatch: false,
							});
						}
						if (astHits.length > 0) {
							const formatted = astHits
								.slice(0, 5)
								.map((h) => {
									const aliasInfo = h.aliasedFrom
										? `\n     (aliased from '${h.aliasedFrom.originalName}' in ${h.aliasedFrom.module || "workspace"})`
										: "";
									return `  → [${h.kind}] ${h.name} (${h.filePath}:${h.line})\n     Signature: ${h.signature}${aliasInfo}`;
								})
								.join("\n");
							return {
								content: [
									{
										type: "text",
										text: `[Tree-sitter AST Fallback - ${astHits.length} declaration match(es) for '${targetSym}']\n${formatted}`,
									},
								],
							};
						}
					}

					return {
						content: [{ type: "text", text: formatDefinitions(defs, ctx.cwd) }],
					};
				}

				if (action === "references") {
					const refs = await client.findReferences(absPath, line0, col0);
					if (refs.length > 0) {
						return {
							content: [{ type: "text", text: formatReferences(refs, ctx.cwd) }],
						};
					}
					// Workspace-wide symbol reference search fallback
					const sym = getSymbolUnderCursor();
					const targetSym = sym.leaf || sym.full;
					if (targetSym) {
						const astRefs = findSymbolReferences(ctx.cwd, targetSym);
						if (astRefs.length > 0) {
							const formatted = astRefs
								.map((r) => `  • ${r.filePath}:${r.line}:${r.column}  ${r.lineText}`)
								.join("\n");
							return {
								content: [
									{
										type: "text",
										text: `[Tree-sitter AST References - ${astRefs.length} match(es) for '${targetSym}']\n${formatted}`,
									},
								],
							};
						}
					}
					return {
						content: [{ type: "text", text: formatReferences(refs, ctx.cwd) }],
					};
				}

				if (action === "hover") {
					const h = await client.hover(absPath, line0, col0);
					const hoverText = formatHover(h);
					if (h && !hoverText.startsWith("No hover information")) {
						return {
							content: [{ type: "text", text: hoverText }],
						};
					}
					// Tree-sitter local variable / parameter / symbol hover fallback
					const sym = getSymbolUnderCursor();
					const targetSym = sym.leaf || sym.full;
					if (targetSym) {
						const localHover = extractLocalSymbolHover(
							absPath,
							line0,
							col0,
							targetSym,
						);
						if (localHover) {
							return { content: [{ type: "text", text: localHover }] };
						}
						const astHits = searchAstSymbols(ctx.cwd, {
							name: targetSym,
							exactMatch: true,
						});
						if (astHits.length > 0) {
							const hit = astHits[0];
							return {
								content: [
									{
										type: "text",
										text: `[Tree-sitter AST Hover - ${hit.kind} ${hit.name}]\n${hit.signature}\nDeclared in ${hit.filePath}:${hit.line}`,
									},
								],
							};
						}
					}

					return {
						content: [{ type: "text", text: hoverText }],
					};
				}

				if (action === "document_symbols") {
					const syms = await client.documentSymbol(absPath);
					if (syms.length > 0) {
						return {
							content: [{ type: "text", text: formatDocumentSymbols(syms) }],
						};
					}
					const docSyms = extractDocumentSymbols(absPath);
					if (docSyms.length > 0) {
						const formatted = docSyms
							.map((s) => `• [${s.kind}] ${s.name} (line ${s.line}) - ${s.signature}`)
							.join("\n");
						return {
							content: [
								{
									type: "text",
									text: `[Tree-sitter AST Document Symbols - ${docSyms.length} symbol(s)]\n${formatted}`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `[Tree-sitter AST] No symbols found in ${path.basename(absPath)}.`,
							},
						],
					};
				}

				if (action === "diagnostics") {
					const diags = await client.getDiagnostics(absPath);
					if (diags.length > 0) {
						return {
							content: [
								{ type: "text", text: formatDiagnostics(diags, absPath, ctx.cwd) },
							],
						};
					}

					// Empty from the server is NOT proof the file is clean — freshly
					// spawned servers often have not analyzed a just-opened document
					// yet (race). Run the cheap structural gate before declaring the
					// file healthy so broken files are never reported as clean.
					const syn = checkSyntax(absPath);
					if (!syn.valid) {
						return {
							content: [
								{
									type: "text",
									text: `Diagnostics for ${path.relative(ctx.cwd, absPath)}:\n  1:1 [ERROR] Syntax Error: ${syn.error}`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No diagnostics reported for ${path.relative(ctx.cwd, absPath)}.`,
							},
						],
					};
				}

				return {
					content: [
						{ type: "text", text: `[LSP ERROR] Unsupported action: ${action}` },
					],
					isError: true,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `[LSP ERROR] ${err.message}` }],
					isError: true,
				};
			}
		},
		renderCall(args: any, theme: any, context: any) {
			const action = args?.action || "query";
			const rawPath = args?.path || "";
			const relPath = rawPath
				? path.relative(context.cwd, rawPath) || rawPath
				: "";
			const pos = args?.line ? `:${args.line}:${args.character || 1}` : "";
			return makeOutputText(
				`${theme.fg("toolTitle", theme.bold("lsp"))} ${theme.fg("accent", `${action} ${relPath}${pos}`)}`,
			);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (context.isError) {
				const errMsg =
					result.content?.find((c: any) => c.type === "text")?.text ||
					"LSP request failed";
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
