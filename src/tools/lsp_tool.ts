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
	uriToPath,
	windowAround,
} from "../lsp";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
	searchAstSymbols,
} from "../retrieval/ast_search";
import { checkSyntax } from "../editing/syntax-verify";
import { kernelDebug } from "../safety/kernel_debug";
import type { SessionDeps } from "./context";

/** Extracted from index.ts — registers the `lsp` tool. */
export function registerLspTool(pi: ExtensionAPI, deps?: SessionDeps): void {
	// 8. Tool: `lsp` (Language Server Protocol Symbol Resolution, Definitions, References, & Diagnostics)
	pi.registerTool({
		name: "lsp",
		label: "Language Server Protocol (LSP)",
		description:
			"Query language server for definitions, references (supports exclude_tests and exclude_declaration), hover docstrings, document symbols, or diagnostics with instant Tree-sitter fallback.",
		promptSnippet:
			"Query LSP for definitions, references (with test filtering), hover type signatures, and workspace diagnostics",
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
			symbol: Type.Optional(
				Type.String({
					description: "Optional symbol name for definition, references, or hover; avoids manual line/character coordinates",
				}),
			),
			exclude_tests: Type.Optional(
				Type.Boolean({
					description: "Exclude references located in test files or test modules (default: false)",
				}),
			),
			exclude_declaration: Type.Optional(
				Type.Boolean({
					description: "Exclude the symbol's own declaration site from references (default: false)",
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
			if (
				!params ||
				typeof params !== "object" ||
				typeof params.path !== "string" ||
				!params.path.trim() ||
				!["definition", "references", "hover", "document_symbols", "diagnostics"].includes(params.action)
			) {
				return {
					content: [{ type: "text", text: "[LSP ERROR] Invalid action or file path." }],
					isError: true,
				};
			}
			const action = params.action;
			const targetPath = params.path;
			if (
				typeof targetPath !== "string" ||
				!targetPath.trim() ||
				!["definition", "references", "hover", "document_symbols", "diagnostics"].includes(action)
			) {
				return {
					content: [{ type: "text", text: "[LSP ERROR] Invalid action or file path." }],
					isError: true,
				};
			}
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

			// Read the source only for local cursor/symbol resolution. An LSP query
			// returns metadata, not model-visible source coverage, so it must not
			// authorize a later mutation.
			let observedContent: Buffer;
			try {
				observedContent = fs.readFileSync(absPath);
			} catch (error: any) {
				return {
					content: [
						{ type: "text", text: `[LSP ERROR] Unable to read ${targetPath}: ${error.message}` },
					],
					isError: true,
				};
			}
			// Intentionally no epistemic read record: the source buffer is an
			// implementation input, not content returned by the LSP operation.

			const requestedSymbol = typeof params.symbol === "string" ? params.symbol.trim() : "";
			let line0 = Math.max(0, (params.line || 1) - 1);
			let col0 = Math.max(0, (params.character || 1) - 1);

			// If a symbol is requested or column coordinate is defaulted to 1 (col0 = 0),
			// check if line0 points to leading whitespace or reserved keywords (e.g. `pub fn`, `export async`).
			// Advance col0 to the actual declared identifier so LSP and AST queries resolve cleanly.
			const fileLines = observedContent.toString("utf8").split("\n");
			if (requestedSymbol && (params.line === undefined || params.character === undefined)) {
				const lineIdx = fileLines.findIndex((l) => {
					const escaped = requestedSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					return new RegExp(`\\b${escaped}\\b`).test(l);
				});
				if (lineIdx !== -1) {
					line0 = lineIdx;
					const charIdx = fileLines[lineIdx].indexOf(requestedSymbol);
					if (charIdx !== -1) col0 = charIdx;
				}
			} else if (params.character === undefined || params.character === 1) {
				const lineText = fileLines[line0] || "";
				const declMatch = lineText.match(/(?:pub(?:\([^)]*\))?\s+|async\s+|fn\s+|function\s+|def\s+|class\s+|interface\s+|type\s+|struct\s+|enum\s+|export\s+|let\s+|const\s+|var\s+)+([a-zA-Z_][a-zA-Z0-9_]*)/);
				if (declMatch && declMatch.index !== undefined && declMatch[1]) {
					const symName = declMatch[1];
					const symOffset = lineText.indexOf(symName, declMatch.index);
					if (symOffset !== -1) {
						col0 = symOffset;
					}
				}
			}

			// Helper: extract identifier / qualified symbol under cursor (supports `foo.bar`, `crate::state::KeyUsage`)
			const getSymbolUnderCursor = (): {
				full: string;
				leaf: string;
				isModule: boolean;
			} => {
				try {
					const fileContent = observedContent.toString("utf8");
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
			// LSP results are metadata, not source visibility. Keep the native buffer
			// local for cursor resolution and never treat it as read evidence.

			// If no client available, fall back cleanly to AST intelligence
			if (!client) {
				if (action === "document_symbols") {
					const docSyms = extractDocumentSymbols(absPath);
					if (docSyms.length > 0) {
						const formatted = docSyms
							.map((s) => `${s.line}: [${s.kind}] ${s.name} - ${s.signature}`)
							.join("\n");
						return {
							content: [
								{
									type: "text",
									text: formatted,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No symbols found in ${path.basename(absPath)}.`,
							},
						],
					};
				}

				if (action === "references") {
					const sym = getSymbolUnderCursor();
					const targetSym = requestedSymbol || sym.leaf || sym.full;
					if (targetSym) {
						const refs = findSymbolReferences(ctx.cwd, targetSym);
						if (refs.length > 0) {
							const formatted = refs
								.map((r) => `${r.filePath}:${r.line}:${r.column}`)
								.join("\n");
							return {
								content: [
									{
										type: "text",
										text: formatted,
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
					const targetSym = requestedSymbol || sym.leaf || sym.full;
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
						const status = syn.status || "failed";
						return {
							content: [
								{
									type: "text",
									text: `- [1:1] [${status.toUpperCase()}] Syntax validation: ${syn.error}`,
								},
							],
						};
					}
					return {
						content: [],
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
					// Only fallback to Tree-sitter AST for programming languages when LSP is unavailable or errored
					const ext = path.extname(absPath).toLowerCase();
					const nonCodeExts = [".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".proto", ".txt"];
					if (nonCodeExts.includes(ext)) {
						return {
							content: [{ type: "text", text: formatDefinitions(defs, ctx.cwd) }],
						};
					}

					// Tree-sitter fallback with exact symbol ranking
					const sym = getSymbolUnderCursor();
					const targetSym = requestedSymbol || sym.leaf || sym.full;
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
					const filterRefs = (locations: any[]) => {
						let res = locations;
						if (params.exclude_declaration) {
							res = res.filter((loc) => {
								const locPath = uriToPath(loc.uri);
								const sameFile = locPath === absPath || path.resolve(locPath) === path.resolve(absPath);
								const sameLine = loc.range?.start?.line === line0;
								return !(sameFile && sameLine);
							});
						}
						if (params.exclude_tests) {
							res = res.filter((loc) => {
								const locPath = uriToPath(loc.uri).replace(/\\/g, "/").toLowerCase();
								const fileName = path.basename(locPath);
								const isTestPath =
									locPath.includes("/test/") ||
									locPath.includes("/tests/") ||
									locPath.startsWith("tests/") ||
									locPath.startsWith("test/") ||
									locPath.includes("__tests__") ||
									fileName.startsWith("test_") ||
									fileName.endsWith("_test.rs") ||
									fileName.endsWith("_test.go") ||
									fileName.endsWith("_test.py") ||
									fileName.endsWith(".test.ts") ||
									fileName.endsWith(".spec.ts") ||
									fileName.endsWith(".test.js");
								return !isTestPath;
							});
						}
						return res;
					};

					let refs = await client.findReferences(absPath, line0, col0);
					if (refs.length > 0) {
						refs = filterRefs(refs);
						if (refs.length > 0) {
							return {
								content: [{ type: "text", text: formatReferences(refs, ctx.cwd) }],
							};
						}
					}
					const ext = path.extname(absPath).toLowerCase();
					const nonCodeExts = [".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".proto", ".txt"];
					if (nonCodeExts.includes(ext)) {
						return {
							content: [{ type: "text", text: formatReferences(refs, ctx.cwd) }],
						};
					}

					// Workspace-wide symbol reference search fallback
					const sym = getSymbolUnderCursor();
					const targetSym = requestedSymbol || sym.leaf || sym.full;
					if (targetSym) {
						let astRefs = findSymbolReferences(ctx.cwd, targetSym);
						if (params.exclude_declaration) {
							astRefs = astRefs.filter((r) => {
								const sameFile = path.resolve(ctx.cwd, r.filePath) === path.resolve(absPath);
								return !(sameFile && r.line === (line0 + 1));
							});
						}
						if (params.exclude_tests) {
							astRefs = astRefs.filter((r) => {
								const norm = r.filePath.replace(/\\/g, "/").toLowerCase();
								const fileName = path.basename(norm);
								return !(
									norm.includes("/test/") ||
									norm.includes("/tests/") ||
									norm.startsWith("tests/") ||
									norm.startsWith("test/") ||
									norm.includes("__tests__") ||
									fileName.startsWith("test_") ||
									fileName.endsWith("_test.rs") ||
									fileName.endsWith("_test.go") ||
									fileName.endsWith("_test.py") ||
									fileName.endsWith(".test.ts") ||
									fileName.endsWith(".spec.ts") ||
									fileName.endsWith(".test.js")
								);
							});
						}
						if (astRefs.length > 0) {
							const formatted = astRefs
								.map((r) => {
									const col0 = Math.max(0, r.column - 1);
									const endCol0 = col0 + targetSym.length;
									const snippet = windowAround(r.lineText, col0, endCol0, 50);
									return `${r.filePath}:${r.line}:${r.column}: ${snippet}`;
								})
								.join("\n");
							return {
								content: [
									{
										type: "text",
										text: formatted,
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
					if (requestedSymbol) {
						const candidates = searchAstSymbols(ctx.cwd, {
							name: requestedSymbol,
							exactMatch: true,
							currentFilePath: absPath,
						});
						if (candidates.length === 1) {
							const candidate = candidates[0];
							const candidatePath = path.isAbsolute(candidate.filePath)
								? candidate.filePath
								: path.resolve(ctx.cwd, candidate.filePath);
							const candidateLine = Math.max(0, candidate.line - 1);
							const candidateContent = candidatePath === absPath
								? observedContent.toString("utf8")
								: fs.readFileSync(candidatePath, "utf8");
							const candidateLineText = candidateContent.split("\n")[candidateLine] || "";
							const candidateColumn = Math.max(0, candidateLineText.indexOf(candidate.name));
							const candidateClient = candidatePath === absPath
								? client
								: await lspMgr.getClientForFile(candidatePath, ctx.cwd);
							if (candidateClient) {
								const candidateHover = await candidateClient.hover(candidatePath, candidateLine, candidateColumn);
								const candidateHoverText = formatHover(candidateHover);
								if (candidateHover && !candidateHoverText.startsWith("No hover information")) {
									return { content: [{ type: "text", text: candidateHoverText }] };
								}
							}
							return {
								content: [{ type: "text", text: `[AST Hover] ${candidate.kind} ${candidate.name}\n${candidate.signature}\nDeclared in ${candidate.filePath}:${candidate.line}` }],
							};
						}
						if (candidates.length > 1) {
							return {
								content: [{ type: "text", text: `Multiple declarations found for '${requestedSymbol}':\n${candidates.slice(0, 10).map((candidate) => `- ${candidate.filePath}:${candidate.line} [${candidate.kind}] ${candidate.signature}`).join("\n")}` }],
							};
						}
					}
					const h = await client.hover(absPath, line0, col0);
					const hoverText = formatHover(h);
					if (h && !hoverText.startsWith("No hover information")) {
						return {
							content: [{ type: "text", text: hoverText }],
						};
					}
					const ext = path.extname(absPath).toLowerCase();
					const nonCodeExts = [".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".proto", ".txt"];
					if (nonCodeExts.includes(ext)) {
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
					const ext = path.extname(absPath).toLowerCase();
					const nonCodeExts = [".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".proto", ".txt"];
					if (nonCodeExts.includes(ext)) {
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
					const diagnosticResult = await client.getDiagnosticsResult(absPath);
					if (diagnosticResult.diagnostics.length > 0) {
						return {
							content: [
								{ type: "text", text: formatDiagnostics(diagnosticResult.diagnostics, absPath, ctx.cwd) },
							],
						};
					}

					const syn = checkSyntax(absPath);
					if (!syn.valid) {
						const status = syn.status || "failed";
						return {
							content: [
								{
									type: "text",
									text: `- [1:1] [${status.toUpperCase()}] Syntax validation: ${syn.error}`,
								},
							],
						};
					}

					if (diagnosticResult.status !== "clean") {
						return {
							content: [
								{
									type: "text",
									text: `[LSP ${diagnosticResult.status.toUpperCase()}] No definitive diagnostics result for ${path.relative(ctx.cwd, absPath)} (syntax validation passed).`,
								},
							],
						};
					}

					const relPath = path.relative(ctx.cwd, absPath).replace(/\\/g, "/") || absPath;
					return {
						content: [
							{
								type: "text",
								text: `${relPath} clean`,
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
