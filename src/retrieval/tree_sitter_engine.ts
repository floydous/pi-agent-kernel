import * as path from "node:path";
import * as fs from "node:fs";
import { type SymbolDef, type FileTags } from "./repomap";
import { kernelDebug } from "../safety/kernel_debug";

type WtsParser = any;
type WtsLanguage = any;

interface LanguageGrammarSpec {
	wasmFile: string;
	langKey: string;
}

const EXTENSION_TO_GRAMMAR: Record<string, LanguageGrammarSpec> = {
	// TypeScript / TSX
	".ts": { wasmFile: "tree-sitter-typescript.wasm", langKey: "typescript" },
	".tsx": { wasmFile: "tree-sitter-tsx.wasm", langKey: "tsx" },
	// JavaScript / JSX
	".js": { wasmFile: "tree-sitter-javascript.wasm", langKey: "javascript" },
	".jsx": { wasmFile: "tree-sitter-javascript.wasm", langKey: "javascript" },
	".mjs": { wasmFile: "tree-sitter-javascript.wasm", langKey: "javascript" },
	".cjs": { wasmFile: "tree-sitter-javascript.wasm", langKey: "javascript" },
	// Python
	".py": { wasmFile: "tree-sitter-python.wasm", langKey: "python" },
	// Rust
	".rs": { wasmFile: "tree-sitter-rust.wasm", langKey: "rust" },
	// Go
	".go": { wasmFile: "tree-sitter-go.wasm", langKey: "go" },
	// C / C++
	".c": { wasmFile: "tree-sitter-c.wasm", langKey: "c" },
	".h": { wasmFile: "tree-sitter-c.wasm", langKey: "c" },
	".cpp": { wasmFile: "tree-sitter-cpp.wasm", langKey: "cpp" },
	".hpp": { wasmFile: "tree-sitter-cpp.wasm", langKey: "cpp" },
	".cc": { wasmFile: "tree-sitter-cpp.wasm", langKey: "cpp" },
	// Java
	".java": { wasmFile: "tree-sitter-java.wasm", langKey: "java" },
	// C#
	".cs": { wasmFile: "tree-sitter-c_sharp.wasm", langKey: "c_sharp" },
	// Bash / Shell
	".sh": { wasmFile: "tree-sitter-bash.wasm", langKey: "bash" },
	".bash": { wasmFile: "tree-sitter-bash.wasm", langKey: "bash" },
	// Ruby
	".rb": { wasmFile: "tree-sitter-ruby.wasm", langKey: "ruby" },
	// PHP
	".php": { wasmFile: "tree-sitter-php.wasm", langKey: "php" },
};

function getGrammarsDir(): string {
	// Root of agent-kernel extension: ../../grammars relative to src/retrieval or dist/retrieval
	const candidate1 = path.join(__dirname, "..", "..", "grammars");
	if (fs.existsSync(candidate1)) return candidate1;
	const candidate2 = path.join(process.cwd(), "grammars");
	if (fs.existsSync(candidate2)) return candidate2;
	return candidate1;
}

function resolveWasmPath(wasmFileName: string): string | null {
	const grammarsDir = getGrammarsDir();
	const target = path.join(grammarsDir, wasmFileName);
	if (fs.existsSync(target)) return target;
	return null;
}

export class TreeSitterEngine {
	private static instance: TreeSitterEngine | null = null;
	private initialized = false;
	private initPromise: Promise<boolean> | null = null;
	private parsers = new Map<string, WtsParser>();
	private languages = new Map<string, WtsLanguage>();
	private ParserClass: any = null;
	private LanguageClass: any = null;

	public static getInstance(): TreeSitterEngine {
		if (!TreeSitterEngine.instance) {
			TreeSitterEngine.instance = new TreeSitterEngine();
		}
		return TreeSitterEngine.instance;
	}

	public isSupported(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return ext in EXTENSION_TO_GRAMMAR;
	}

	public getSupportedExtensions(): string[] {
		return Object.keys(EXTENSION_TO_GRAMMAR);
	}

	public async init(): Promise<boolean> {
		if (this.initialized) return true;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			try {
				const wts = await import("web-tree-sitter");
				this.ParserClass = (wts as any).Parser || (wts as any).default?.Parser || wts;
				this.LanguageClass = (wts as any).Language || (wts as any).default?.Language;

				let wtsDir = getGrammarsDir();
				const localWtsWasm = path.join(wtsDir, "web-tree-sitter.wasm");
				if (!fs.existsSync(localWtsWasm)) {
					try {
						const pkgPath = require.resolve("web-tree-sitter");
						wtsDir = path.dirname(pkgPath);
					} catch {
						wtsDir = path.join(process.cwd(), "node_modules", "web-tree-sitter");
					}
				}

				await this.ParserClass.init({
					locateFile: (name: string) => path.join(wtsDir, name),
				});

				// Load all bundled grammars in parallel for instant sub-millisecond AST extraction across all 12 languages
				const loadPromises = Object.entries(EXTENSION_TO_GRAMMAR).map(async ([ext, spec]) => {
					if (!this.languages.has(spec.langKey)) {
						const wasmPath = resolveWasmPath(spec.wasmFile);
						if (wasmPath && fs.existsSync(wasmPath)) {
							try {
								const lang = await this.LanguageClass.load(wasmPath);
								this.languages.set(spec.langKey, lang);
							} catch (e) {
								kernelDebug(`Failed loading grammar for ${spec.langKey}: ${e}`);
							}
						}
					}
					const loadedLang = this.languages.get(spec.langKey);
					if (loadedLang && !this.parsers.has(ext)) {
						const parser = new this.ParserClass();
						parser.setLanguage(loadedLang);
						this.parsers.set(ext, parser);
					}
				});
				await Promise.all(loadPromises);

				this.initialized = this.parsers.size > 0;
				return this.initialized;
			} catch (e) {
				kernelDebug(`TreeSitterEngine init failed: ${e}`);
				this.initialized = false;
				return false;
			}
		})();

		return this.initPromise;
	}

	/**
	 * Preload grammars for specific file extensions or common workspace languages.
	 */
	public async loadLanguages(extensions: string[]): Promise<void> {
		await this.init();
		if (!this.initialized || !this.ParserClass || !this.LanguageClass) return;

		for (const ext of extensions) {
			const spec = EXTENSION_TO_GRAMMAR[ext];
			if (!spec) continue;

			if (!this.languages.has(spec.langKey)) {
				const wasmPath = resolveWasmPath(spec.wasmFile);
				if (wasmPath && fs.existsSync(wasmPath)) {
					try {
						const lang = await this.LanguageClass.load(wasmPath);
						this.languages.set(spec.langKey, lang);
					} catch (e) {
						kernelDebug(`Failed to load grammar for ${spec.langKey}: ${e}`);
					}
				}
			}

			const loadedLang = this.languages.get(spec.langKey);
			if (loadedLang && !this.parsers.has(ext)) {
				const parser = new this.ParserClass();
				parser.setLanguage(loadedLang);
				this.parsers.set(ext, parser);
			}
		}
	}

	public extractTags(filePath: string, content: string): FileTags | null {
		const ext = path.extname(filePath).toLowerCase();
		const parser = this.parsers.get(ext);
		if (!this.initialized || !parser) {
			return null;
		}

		let tree: any = null;
		try {
			tree = parser.parse(content);
			const root = tree.rootNode;
			const definitions: SymbolDef[] = [];
			const references = new Set<string>();

			const idRegex = /\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/g;
			let match: RegExpExecArray | null;
			while ((match = idRegex.exec(content)) !== null) {
				references.add(match[1]);
			}

			function getCleanSignature(node: any): string {
				const body = node.childForFieldName("body");
				let headerText = "";
				if (body) {
					headerText = content.slice(node.startIndex, body.startIndex).trim();
				} else {
					headerText = node.text.split("\n")[0].trim();
				}
				return headerText.replace(/\s*\{$/, "").replace(/\s+/g, " ").trim();
			}

			function visit(node: any, inFunctionScope = false) {
				const type = node.type;

				// --- Python import_from_statement (Aliases) ---
				if (type === "import_from_statement") {
					const modNode = node.childForFieldName("module_name") || node.namedChildren.find((c: any) => c.type === "dotted_name" || c.type === "relative_import");
					let modName = modNode ? modNode.text.replace(/^\.+/, "") : undefined;
					function findAliases(n: any) {
						if (n.type === "aliased_import") {
							const orig = n.childForFieldName("name")?.text;
							const alias = n.childForFieldName("alias")?.text;
							if (orig && alias) {
								definitions.push({
									name: alias,
									kind: "alias",
									signature: `${alias} = ${orig}`,
									line: n.startPosition.row + 1,
									endLine: n.endPosition.row + 1,
									aliasedFrom: {
										module: modName,
										originalName: orig,
									},
								});
							}
							return;
						}
						for (const c of n.namedChildren) findAliases(c);
					}
					findAliases(node);
					return;
				}

				// Reject declarations inside function/method bodies (prevents local variables and closures from leaking into repo symbols)
				if (inFunctionScope) {
					return;
				}

				// --- TypeScript / JavaScript / TSX ---
				if (type === "function_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "function",
							signature: getCleanSignature(node).replace(/^export\s+/, ""),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					// Stop traversal into function body
					return;
				} else if (type === "class_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "class",
							signature: getCleanSignature(node).replace(/^export\s+/, ""),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					// Traverse class members, but NOT function scope yet
					const body = node.childForFieldName("body");
					if (body) {
						for (const member of body.namedChildren) {
							visit(member, false);
						}
					}
					return;
				} else if (type === "interface_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "interface",
							signature: getCleanSignature(node).replace(/^export\s+/, ""),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "type_alias_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "type",
							signature: `type ${nameNode.text}`,
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "enum_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "enum",
							signature: `enum ${nameNode.text}`,
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "method_definition") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "method",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					// Method definition has been recorded; do not traverse inside method body
					return;
				} else if ((type === "lexical_declaration" || type === "variable_declaration") && (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs")) {
					// Only top-level variable declarations (in program or export statement)
					const isTopLevel = node.parent?.type === "program" || node.parent?.type === "export_statement";
					if (isTopLevel) {
						for (const child of node.namedChildren) {
							if (child.type === "variable_declarator") {
								const nameNode = child.childForFieldName("name");
								const valueNode = child.childForFieldName("value");
								if (nameNode) {
									const isFn = valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function");
									const isAllUpper = /^[A-Z0-9_]{2,}$/.test(nameNode.text);
									definitions.push({
										name: nameNode.text,
										kind: isFn ? "function" : isAllUpper ? "constant" : "variable",
										signature: getCleanSignature(node).replace(/^export\s+/, ""),
										line: node.startPosition.row + 1,
										endLine: node.endPosition.row + 1,
									});
								}
							}
						}
					}
					return;
				}

				// --- Python ---
				else if (type === "function_definition" && (ext === ".py")) {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						let isMethod = false;
						let p = node.parent;
						while (p) {
							if (p.type === "class_definition") {
								isMethod = true;
								break;
							}
							p = p.parent;
						}
						definitions.push({
							name: nameNode.text,
							kind: isMethod ? "method" : "function",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "decorated_definition" && (ext === ".py")) {
					// Unwrap python decorator to find inner function or class definition
					const defNode = node.childForFieldName("definition") || node.namedChildren.find((c: any) => c.type === "function_definition" || c.type === "class_definition");
					if (defNode) {
						visit(defNode, inFunctionScope);
					}
					return;
				} else if (type === "class_definition" && (ext === ".py")) {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "class",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					const body = node.childForFieldName("body");
					if (body) {
						for (const member of body.namedChildren) {
							visit(member, false);
						}
					}
					return;
				} else if (type === "expression_statement" && (ext === ".py")) {
					// Expression statements in Python do not define repository symbols
					return;
				}

				// --- Rust ---
				else if (type === "function_item") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						const isMethod = node.parent && node.parent.type === "declaration_list" && node.parent.parent && node.parent.parent.type === "impl_item";
						definitions.push({
							name: nameNode.text,
							kind: isMethod ? "method" : "function",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "struct_item" || type === "enum_item" || type === "trait_item") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: type === "enum_item" ? "enum" : "class",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "type_item") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "type",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "const_item" || type === "static_item") {
					const isTopLevel = node.parent?.type === "source_file";
					if (isTopLevel) {
						const nameNode = node.childForFieldName("name");
						if (nameNode) {
							definitions.push({
								name: nameNode.text,
								kind: type === "const_item" ? "constant" : "variable",
								signature: getCleanSignature(node),
								line: node.startPosition.row + 1,
								endLine: node.endPosition.row + 1,
							});
						}
					}
					return;
				}

				// --- Go ---
				else if (type === "function_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "function",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "method_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "method",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "type_declaration") {
					for (const child of node.namedChildren) {
						if (child.type === "type_spec") {
							const nameNode = child.childForFieldName("name");
							if (nameNode) {
								definitions.push({
									name: nameNode.text,
									kind: "class",
									signature: getCleanSignature(child),
									line: child.startPosition.row + 1,
									endLine: child.endPosition.row + 1,
								});
							}
						}
					}
					return;
				}

				// --- C / C++ ---
				else if (type === "function_definition" && (ext === ".c" || ext === ".cpp" || ext === ".h" || ext === ".hpp" || ext === ".cc")) {
					const declarator = node.childForFieldName("declarator");
					let name = "";
					if (declarator) {
						if (declarator.type === "identifier") {
							name = declarator.text;
						} else {
							const idNode = declarator.childForFieldName("declarator") || declarator.namedChildren.find((c: any) => c.type === "identifier");
							if (idNode) {
								name = idNode.text;
							} else {
								name = declarator.text.split("(")[0].trim();
							}
						}
					}
					if (name) {
						definitions.push({
							name: name.replace(/^[*&]+/, "").trim(),
							kind: "function",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "class_specifier" || type === "struct_specifier") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "class",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					const body = node.childForFieldName("body");
					if (body) {
						for (const member of body.namedChildren) {
							visit(member, false);
						}
					}
					return;
				}

				// --- Java / C# ---
				else if (type === "constructor_declaration" || type === "method_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "method",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if (type === "enum_declaration" && (ext === ".cs" || ext === ".java")) {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "enum",
							signature: `enum ${nameNode.text}`,
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				}

				// --- Ruby ---
				else if (type === "method" || type === "singleton_method") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						let isMethod = false;
						let p = node.parent;
						while (p) {
							if (p.type === "class" || p.type === "module") {
								isMethod = true;
								break;
							}
							p = p.parent;
						}
						definitions.push({
							name: nameNode.text,
							kind: isMethod ? "method" : "function",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				} else if ((type === "class" || type === "module") && ext === ".rb") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "class",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					const body = node.childForFieldName("body");
					if (body) {
						for (const member of body.namedChildren) {
							visit(member, false);
						}
					}
					return;
				}

				// --- PHP ---
				else if (type === "method_declaration") {
					const nameNode = node.childForFieldName("name");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "method",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				}

				// --- Bash ---
				else if (type === "function_definition" && (ext === ".sh" || ext === ".bash")) {
					const nameNode = node.childForFieldName("name") || node.namedChildren.find((c: any) => c.type === "word");
					if (nameNode) {
						definitions.push({
							name: nameNode.text,
							kind: "function",
							signature: getCleanSignature(node),
							line: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						});
					}
					return;
				}

				// --- Imports / Exports Aliases (TS/JS) ---
				else if (type === "export_statement" || type === "import_statement") {
					const text = node.text;
					if (text.includes(" as ")) {
						const asMatch = text.match(/\b([a-zA-Z0-9_]+)\s+as\s+([a-zA-Z0-9_]+)\b/);
						if (asMatch) {
							const modMatch = text.match(/from\s*['"]([^'"]+)['"]/);
							definitions.push({
								name: asMatch[2],
								kind: "alias",
								signature: text.split("\n")[0].trim(),
								line: node.startPosition.row + 1,
								endLine: node.endPosition.row + 1,
								aliasedFrom: {
									module: modMatch ? modMatch[1] : undefined,
									originalName: asMatch[1],
								},
							});
						}
					}
				}

				for (const child of node.namedChildren) {
					visit(child, false);
				}
			}

			visit(root, false);

			return {
				filePath,
				definitions,
				references,
			};
		} catch (e) {
			kernelDebug(`TreeSitterEngine extractTags error on ${filePath}: ${e}`);
			return null;
		} finally {
			if (tree) {
				try {
					tree.delete();
				} catch {
					// ignore deletion error
				}
			}
		}
	}
}
