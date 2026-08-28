import * as fs from "node:fs";
import * as path from "node:path";
import { extractFileTags } from "./repomap";
import { kernelDebug } from "../safety/kernel_debug";

export interface AstQueryResult {
	filePath: string;
	name: string;
	kind: string;
	signature: string;
	line: number;
	codeBlock?: string;
	bodyTruncated?: boolean;
	aliasedFrom?: {
		module?: string;
		originalName: string;
	};
}

export interface SymbolReference {
	filePath: string;
	line: number;
	column: number;
	lineText: string;
}

/** Escape regex metacharacters in user-supplied symbol names before RegExp interpolation. */
function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RESERVED_KEYWORDS = new Set([
	"import",
	"from",
	"as",
	"export",
	"default",
	"return",
	"const",
	"let",
	"var",
	"function",
	"async",
	"await",
	"class",
	"interface",
	"type",
	"def",
	"self",
	"cls",
	"if",
	"else",
	"elif",
	"for",
	"while",
	"try",
	"except",
	"catch",
	"finally",
	"with",
	"pub",
	"fn",
	"struct",
	"enum",
	"trait",
	"impl",
	"use",
	"mod",
	"crate",
	"super",
	"mut",
	"ref",
	"static",
	"func",
	"package",
]);

const SUPPORTED_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".c",
	".cpp",
	".h",
	".hpp",
	".zig",
	".rb",
	".java",
	".kt",
	".php",
	".lua",
]);

const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	"target",
	"dist",
	"build",
	".next",
	"__pycache__",
	".pytest_cache",
	".venv",
	"venv",
]);

/**
 * Extract top-level symbols from a single file using fast AST tagging
 */
export function extractDocumentSymbols(filePath: string): AstQueryResult[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		const content = fs.readFileSync(filePath, "utf-8");
		const tags = extractFileTags(filePath, content);
		const relPath = filePath.replace(/\\/g, "/");

		return tags.definitions.map((def) => ({
			filePath: relPath,
			name: def.name,
			kind: def.kind,
			signature: def.signature,
			line: def.line,
			aliasedFrom: def.aliasedFrom,
		}));
	} catch {
		return [];
	}
}

// Helper to check if a character index is inside a comment or string literal
function isInsideCommentOrString(line: string, index: number): boolean {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let inBacktick = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		const nextCh = line[i + 1];

		if (i === index) {
			if (inSingleQuote || inDoubleQuote || inBacktick) return true;
		}

		if (ch === "\\" && (inSingleQuote || inDoubleQuote || inBacktick)) {
			i++; // skip escaped char
			continue;
		}

		if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
			if (ch === "/" && nextCh === "/") {
				return index >= i;
			}
			if (ch === "#") {
				return index >= i;
			}
			if (ch === "-" && nextCh === "-") {
				return index >= i;
			}
		}

		if (ch === "'" && !inDoubleQuote && !inBacktick)
			inSingleQuote = !inSingleQuote;
		else if (ch === '"' && !inSingleQuote && !inBacktick)
			inDoubleQuote = !inDoubleQuote;
		else if (ch === "`" && !inSingleQuote && !inDoubleQuote)
			inBacktick = !inBacktick;
	}

	return false;
}

/**
 * Find word-boundary symbol references across the workspace
 */
export function findSymbolReferences(
	rootDir: string,
	symbolName: string,
	maxResults = 40,
): SymbolReference[] {
	const results: SymbolReference[] = [];
	if (!symbolName || !symbolName.trim()) return results;

	// Strip potential module prefixes if passed
	const cleanSym = symbolName.includes("::")
		? symbolName.split("::").pop()!.trim()
		: symbolName.includes(".")
			? symbolName.split(".").pop()!.trim()
			: symbolName.trim();
	if (!cleanSym || RESERVED_KEYWORDS.has(cleanSym.toLowerCase())) return results;

	const escaped = cleanSym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`\\b${escaped}\\b`, "g");

	function walk(dir: string) {
		if (results.length >= maxResults) return;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (results.length >= maxResults) break;
			if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;

			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

				try {
					const content = fs.readFileSync(fullPath, "utf-8");
					const lines = content.split("\n");
					let inBlockComment = false;

					for (let i = 0; i < lines.length; i++) {
						if (results.length >= maxResults) break;
						const lineText = lines[i];
						const trimmed = lineText.trim();

						// Block comment handling (/* ... */)
						if (inBlockComment) {
							if (trimmed.includes("*/")) {
								inBlockComment = false;
							}
							continue;
						}
						if (trimmed.startsWith("/*")) {
							if (!trimmed.includes("*/")) {
								inBlockComment = true;
							}
							continue;
						}

						// Skip lines starting with comment markers
						if (
							trimmed.startsWith("//") ||
							trimmed.startsWith("///") ||
							trimmed.startsWith("//!") ||
							trimmed.startsWith("#") ||
							trimmed.startsWith("*") ||
							trimmed.startsWith("--")
						) {
							continue;
						}

						let match;
						regex.lastIndex = 0;
						while ((match = regex.exec(lineText)) !== null) {
							// Filter out matches inside inline comments or string literals
							if (isInsideCommentOrString(lineText, match.index)) {
								continue;
							}

							results.push({
								filePath:
									path.relative(rootDir, fullPath).replace(/\\/g, "/") || fullPath,
								line: i + 1,
								column: match.index + 1,
								lineText: lineText.trim(),
							});
							if (results.length >= maxResults) break;
						}
					}
				} catch (e) {
					kernelDebug(e);
				}
			}
		}
	}

	walk(rootDir);
	return results;
}

/**
 * Extract hover information for local variable, parameter, import alias, or local assignment in scope
 */
export function extractLocalSymbolHover(
	filePath: string,
	line0: number,
	_col0: number,
	symName: string,
): string | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		if (!symName || RESERVED_KEYWORDS.has(symName.toLowerCase())) {
			return null;
		}

		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const currentLine = lines[line0] || "";

		// 1. If current line is an import statement containing symName:
		if (
			currentLine.includes("import") ||
			currentLine.includes("from ") ||
			currentLine.includes("export ") ||
			currentLine.includes("use ")
		) {
			// Check for alias: `from ... import orig as symName` or `import ... as symName` or `use ... as symName`
			const aliasRegex = new RegExp(
				`\\b([a-zA-Z0-9_]+)\\s+as\\s+${escapeRegExp(symName)}\\b`,
			);
			const aliasMatch = currentLine.match(aliasRegex);
			if (aliasMatch) {
				const modMatch =
					currentLine.match(/from\s+([.\w]+)/) ||
					currentLine.match(/from\s+['"]([^'"]+)['"]/) ||
					currentLine.match(/use\s+([^;]+)/);
				const mod = modMatch ? modMatch[1] : "module";
				return `(import alias) ${symName} → ${aliasMatch[1]}\nImported from ${mod} in ${path.basename(filePath)}:${line0 + 1}:\n${currentLine.trim()}`;
			}

			// Check for direct import: `from mod import ..., symName, ...` or `use crate::...::symName;`
			const directImportRegex = new RegExp(`\\b${escapeRegExp(symName)}\\b`);
			if (directImportRegex.test(currentLine)) {
				const modMatch =
					currentLine.match(/from\s+([.\w]+)/) ||
					currentLine.match(/from\s+['"]([^'"]+)['"]/) ||
					currentLine.match(/use\s+([^;]+)/);
				const mod = modMatch ? modMatch[1] : "module";
				return `(imported symbol) ${symName}\nImported from ${mod} in ${path.basename(filePath)}:${line0 + 1}:\n${currentLine.trim()}`;
			}
		}

		// 2. First scan upwards for enclosing function header to check if symName is a parameter
		const startScan = Math.max(0, line0 - 80);
		for (let i = line0; i >= startScan; i--) {
			const line = lines[i] || "";
			const trimmed = line.trim();

			if (
				trimmed.startsWith("import ") ||
				trimmed.startsWith("from ") ||
				trimmed.startsWith("export {") ||
				trimmed.startsWith("use ")
			) {
				continue;
			}

			const isFnHeader =
				trimmed.startsWith("def ") ||
				trimmed.startsWith("async def ") ||
				trimmed.startsWith("function ") ||
				trimmed.startsWith("async function ") ||
				trimmed.includes("function ") ||
				trimmed.startsWith("pub fn ") ||
				trimmed.startsWith("pub async fn ") ||
				trimmed.startsWith("fn ") ||
				trimmed.startsWith("async fn ") ||
				trimmed.startsWith("func ") ||
				trimmed.includes("=>") ||
				/^(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(?:def|function|[a-zA-Z0-9_]+\s*\()/.test(
					trimmed,
				) ||
				/^(?:export\s+)?const\s+[a-zA-Z0-9_]+\s*=\s*(?:async\s*)?\(/.test(trimmed);

			if (isFnHeader) {
				// Collect the entire parameter block between ( and )
				let parenDepth = 0;
				let seenOpen = false;
				let paramBlock = "";

				for (let j = i; j < Math.min(lines.length, i + 25); j++) {
					const l = lines[j];
					for (let c = 0; c < l.length; c++) {
						const ch = l[c];
						if (ch === "(") {
							parenDepth++;
							seenOpen = true;
							if (parenDepth === 1) continue;
						} else if (ch === ")") {
							parenDepth--;
							if (seenOpen && parenDepth === 0) break;
						}
						if (seenOpen && parenDepth > 0) {
							paramBlock += ch;
						}
					}
					if (seenOpen && parenDepth === 0) break;
					paramBlock += " ";
				}

				if (seenOpen && paramBlock) {
					const cleanParams = paramBlock.replace(/\s+/g, " ");
					const paramRegex = new RegExp(
						`\\b${escapeRegExp(symName)}\\b(?:\\s*:\\s*([^,)=]+))?(?:\\s*=\\s*([^,)]+))?`,
					);
					const m = cleanParams.match(paramRegex);
					if (m) {
						const typeAnnot = m[1] ? `: ${m[1].trim()}` : "";
						const defVal = m[2] ? ` = ${m[2].trim()}` : "";
						return `(parameter) ${symName}${typeAnnot}${defVal}\nDefined in ${path.basename(filePath)}:${i + 1}`;
					}
				}
			}
		}

		// 3. Scan upwards for local variable declarations (Rust let/static/const, Go :=/var, TS/JS const/let/var, Python)
		for (let i = line0; i >= startScan; i--) {
			const line = lines[i] || "";
			const trimmed = line.trim();

			if (
				trimmed.startsWith("import ") ||
				trimmed.startsWith("from ") ||
				trimmed.startsWith("def ") ||
				trimmed.startsWith("class ") ||
				trimmed.startsWith("use ")
			) {
				continue;
			}

			// Don't treat parameter lines ending with comma as local variable statements
			if (trimmed.endsWith(",")) {
				continue;
			}

			// Rust: `let [mut] [ref] symName[: Type] [= value];`
			const rsLetMatch = line.match(
				new RegExp(
					`^\\s*let\\s+(?:mut\\s+|ref\\s+mut\\s+|ref\\s+)?${escapeRegExp(symName)}\\b(?:\\s*:\\s*([^=;]+))?(?:\\s*=\\s*([^;\\n]+))?`,
				),
			);
			if (rsLetMatch) {
				const typeAnnot = rsLetMatch[1] ? `: ${rsLetMatch[1].trim()}` : "";
				const valPreview = rsLetMatch[2]
					? ` = ${rsLetMatch[2].trim().slice(0, 60)}`
					: "";
				return `(local variable) ${symName}${typeAnnot}${valPreview}\nDeclared in ${path.basename(filePath)}:${i + 1}`;
			}

			// Rust/C++: `[pub] static [mut] symName: Type = value;` or `[pub] const symName: Type = value;`
			const rsStaticMatch = line.match(
				new RegExp(
					`^\\s*(?:pub\\s+)?(static|const)\\s+(?:mut\\s+)?${escapeRegExp(symName)}\\b(?:\\s*:\\s*([^=;]+))?(?:\\s*=\\s*([^;\\n]+))?`,
				),
			);
			if (rsStaticMatch) {
				const kindLabel =
					rsStaticMatch[1] === "static" ? "static variable" : "constant";
				const typeAnnot = rsStaticMatch[2] ? `: ${rsStaticMatch[2].trim()}` : "";
				const valPreview = rsStaticMatch[3]
					? ` = ${rsStaticMatch[3].trim().slice(0, 60)}`
					: "";
				return `(${kindLabel}) ${symName}${typeAnnot}${valPreview}\nDeclared in ${path.basename(filePath)}:${i + 1}`;
			}

			// Go: `symName := value` or `var symName [Type] [= value]`
			const goShortMatch = line.match(
				new RegExp(`^\\s*${escapeRegExp(symName)}\\s*:=\\s*([^;\\n]+)`),
			);
			if (goShortMatch) {
				return `(local variable) ${symName} := ${goShortMatch[1].trim().slice(0, 60)}\nDeclared in ${path.basename(filePath)}:${i + 1}`;
			}
			const goVarMatch = line.match(
				new RegExp(
					`^\\s*var\\s+${escapeRegExp(symName)}\\b(?:\\s+([^=;]+))?(?:\\s*=\\s*([^;\\n]+))?`,
				),
			);
			if (goVarMatch) {
				const typeAnnot = goVarMatch[1] ? ` ${goVarMatch[1].trim()}` : "";
				const valPreview = goVarMatch[2]
					? ` = ${goVarMatch[2].trim().slice(0, 60)}`
					: "";
				return `(variable) ${symName}${typeAnnot}${valPreview}\nDeclared in ${path.basename(filePath)}:${i + 1}`;
			}

			// TS/JS: `(const|let|var|this.) symName[: Type] = value;`
			const assignRegex = new RegExp(
				`^\\s*(?:const|let|var|self\\.|this\\.)\\s*${escapeRegExp(symName)}\\b(?:\\s*:\\s*([^=]+))?\\s*=\\s*([^;\\n]+)`,
			);
			const assignMatch = line.match(assignRegex);
			if (assignMatch) {
				const typeAnnot = assignMatch[1] ? `: ${assignMatch[1].trim()}` : "";
				const valPreview = assignMatch[2]
					? ` = ${assignMatch[2].trim().slice(0, 60)}`
					: "";
				return `(local variable) ${symName}${typeAnnot}${valPreview}\nDeclared in ${path.basename(filePath)}:${i + 1}`;
			}

			// Python dynamic variable assignment (e.g. `symName = ...` or `self.symName = ...`)
			const pyAssignRegex = new RegExp(
				`^\\s*${escapeRegExp(symName)}\\b(?:\\s*:\\s*([^=]+))?\\s*=\\s*([^;\\n]+)`,
			);
			const pyAssignMatch = line.match(pyAssignRegex);
			if (pyAssignMatch && !trimmed.endsWith(",")) {
				const typeAnnot = pyAssignMatch[1] ? `: ${pyAssignMatch[1].trim()}` : "";
				const valPreview = pyAssignMatch[2]
					? ` = ${pyAssignMatch[2].trim().slice(0, 60)}`
					: "";
				return `(local variable) ${symName}${typeAnnot}${valPreview}\nDeclared in ${path.basename(filePath)}:${i + 1}`;
			}
		}

		// 4. Check if symName is declared directly in this file's document symbols (top priority for local file hover)
		const localDocSyms = extractDocumentSymbols(filePath);
		const exactLocal = localDocSyms.find(
			(s) => s.name === symName || s.name.toLowerCase() === symName.toLowerCase(),
		);
		if (exactLocal) {
			return `[${exactLocal.kind}] ${exactLocal.name}\n${exactLocal.signature}\nDeclared in ${path.basename(filePath)}:${exactLocal.line}`;
		}

		// 5. Scan file-level import statements
		for (let i = 0; i < Math.min(lines.length, 120); i++) {
			const line = lines[i].trim();
			if (
				line.startsWith("import ") ||
				line.startsWith("from ") ||
				line.startsWith("export ") ||
				line.startsWith("use ")
			) {
				const aliasRegex = new RegExp(
					`\\b([a-zA-Z0-9_]+)\\s+as\\s+${escapeRegExp(symName)}\\b`,
				);
				const m = line.match(aliasRegex);
				if (m) {
					return `(import alias) ${symName} → ${m[1]}\nImport statement in ${path.basename(filePath)}:${i + 1}:\n${line}`;
				}
			}
		}
	} catch (e) {
		kernelDebug(e);
	}
	return null;
}

/**
 * Multi-tier ranking function to sort AST symbols:
 * 1. Current File Bonus (local declarations in current active file always rank first)
 * 2. Match Precision (Exact > Case-Insensitive > Word-Boundary > StartsWith > Test-Match > Substring)
 * 3. Source Code vs Tests/Benchmarks/Examples (Production files heavily favored)
 * 4. Module Hint Matching (for dotted / qualified lookups e.g. webshocket.WebSocketClient, state::KeyUsage)
 * 5. Symbol Kind (Class/Struct/Enum > Interface/Trait > Function > Method > Alias > Variable)
 * 6. Path Depth
 */
export function computeSymbolRankScore(
	symbol: AstQueryResult,
	queryName?: string,
	currentFilePath?: string,
): number {
	if (!queryName) return 0;

	// Handle dotted / colon-qualified query expressions (e.g. "crate::state::KeyUsage" or "webshocket.WebSocketClient")
	const cleanQuery = queryName.replace(/::/g, ".");
	const parts = cleanQuery.split(".");
	const leafQuery = parts[parts.length - 1];
	const moduleHint =
		parts.length > 1 ? parts.slice(0, -1).join("/").toLowerCase() : "";

	const sName = symbol.name.toLowerCase();
	const qName = leafQuery.toLowerCase();
	const fPath = symbol.filePath.toLowerCase().replace(/\\/g, "/");

	// Tier 0: Current File Priority Boost (-200 bonus ensures active file always wins)
	let localFileBonus = 0;
	if (currentFilePath) {
		const normCurrent = currentFilePath.replace(/\\/g, "/").toLowerCase();
		if (
			normCurrent.endsWith(fPath) ||
			fPath.endsWith(normCurrent) ||
			normCurrent === fPath
		) {
			localFileBonus = -200;
		}
	}

	// Tier 1: Match precision
	let matchScore = 50;
	if (symbol.name === leafQuery) {
		matchScore = 0; // Exact case match
	} else if (sName === qName) {
		matchScore = 5; // Exact case-insensitive match
	} else if (
		new RegExp(`\\b${qName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
			symbol.name,
		)
	) {
		matchScore = 15; // Word boundary match
	} else if (sName.startsWith(qName)) {
		matchScore = 25; // Prefix match
	} else if (
		sName.startsWith("test_") ||
		sName.endsWith("_test") ||
		sName.startsWith("test")
	) {
		matchScore = 80; // Test function match
	} else {
		matchScore = 50; // Generic substring match
	}

	// Tier 2: Source Code vs Tests / Benchmarks / Examples
	let locationPenalty = 0;
	const isTestPath =
		fPath.includes("/test/") ||
		fPath.includes("/tests/") ||
		fPath.includes("/__tests__/") ||
		fPath.includes("/spec/") ||
		fPath.includes("/specs/") ||
		fPath.startsWith("test/") ||
		fPath.startsWith("tests/") ||
		fPath.startsWith("spec/") ||
		fPath.includes("test_") ||
		fPath.includes("_test.") ||
		fPath.includes(".test.") ||
		fPath.includes(".spec.");

	const isBenchmarkOrExample =
		fPath.includes("/benchmarks/") ||
		fPath.includes("/benchmark/") ||
		fPath.includes("/examples/") ||
		fPath.includes("/example/") ||
		fPath.includes("/samples/") ||
		fPath.includes("/fixtures/") ||
		fPath.startsWith("benchmarks/") ||
		fPath.startsWith("examples/") ||
		fPath.startsWith("samples/");

	if (isTestPath) {
		locationPenalty = 150; // Strong penalty for test files
	} else if (isBenchmarkOrExample) {
		locationPenalty = 60; // Moderate penalty for examples/benchmarks
	} else if (
		fPath.startsWith("src/") ||
		fPath.startsWith("lib/") ||
		fPath.startsWith("app/") ||
		fPath.startsWith("core/") ||
		fPath.startsWith("pkg/") ||
		fPath.includes("/src/") ||
		fPath.includes("/lib/") ||
		fPath.includes("/app/")
	) {
		locationPenalty = 0; // Production source code gets highest priority
	} else {
		locationPenalty = 10; // Root source files
	}

	// Tier 3: Module hint match bonus
	let moduleBonus = 0;
	if (moduleHint && fPath.includes(moduleHint)) {
		moduleBonus = -30; // Boost for matching module path
	}

	// Tier 4: Symbol Kind Weight
	let kindScore = 5;
	switch (symbol.kind.toLowerCase()) {
		case "class":
		case "struct":
		case "enum":
			kindScore = 0;
			break;
		case "interface":
		case "trait":
		case "type":
			kindScore = 1;
			break;
		case "function":
			kindScore = 2;
			break;
		case "method":
			kindScore = 3;
			break;
		case "alias":
			kindScore = 4;
			break;
		case "variable":
		case "constant":
			kindScore = 5;
			break;
		default:
			kindScore = 6;
	}

	// Tier 5: Path depth (shallower files preferred)
	const pathDepth = (fPath.match(/\//g) || []).length * 0.1;

	return (
		localFileBonus +
		matchScore +
		locationPenalty +
		moduleBonus +
		kindScore * 0.1 +
		pathDepth
	);
}

export function searchAstSymbols(
	rootDir: string,
	query: {
		name?: string;
		kind?: string;
		filePattern?: string;
		includeBody?: boolean;
		exactMatch?: boolean;
		currentFilePath?: string;
	},
): AstQueryResult[] {
	const rawResults: AstQueryResult[] = [];
	const allDefsByFile = new Map<string, AstQueryResult[]>();

	// If query.name contains dots or colons (e.g. "crate::state::KeyUsage" or "webshocket.WebSocketClient"), extract leaf
	const cleanQueryName = query.name ? query.name.replace(/::/g, ".") : undefined;
	const queryLeaf =
		cleanQueryName && cleanQueryName.includes(".")
			? cleanQueryName.split(".").pop()!
			: cleanQueryName;

	function walk(dir: string) {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
				continue;
			}
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
				if (
					query.filePattern &&
					!relPath
						.toLowerCase()
						.includes(query.filePattern.replace(/\\/g, "/").toLowerCase())
				) {
					continue;
				}
				const ext = path.extname(entry.name).toLowerCase();
				if (!SUPPORTED_EXTENSIONS.has(ext)) {
					continue;
				}
				try {
					const content = fs.readFileSync(fullPath, "utf-8");
					const tags = extractFileTags(fullPath, content);
					const lines = content.split("\n");
					const fileDefs: AstQueryResult[] = [];

					for (const def of tags.definitions) {
						let codeBlock: string | undefined;
						let bodyTruncated = false;
						if (query.includeBody) {
							const start = Math.max(0, def.line - 1);
							const end = Math.min(lines.length, start + 25);
							codeBlock = lines.slice(start, end).join("\n");
							bodyTruncated = end < lines.length;
						}

						const item: AstQueryResult = {
							filePath: relPath,
							name: def.name,
							kind: def.kind,
							signature: def.signature,
							line: def.line,
							codeBlock,
							bodyTruncated: query.includeBody ? bodyTruncated : undefined,
							aliasedFrom: def.aliasedFrom,
						};

						fileDefs.push(item);

						if (query.kind && def.kind.toLowerCase() !== query.kind.toLowerCase()) {
							continue;
						}

						if (queryLeaf) {
							const qName = queryLeaf.toLowerCase();
							const dName = def.name.toLowerCase();
							if (query.exactMatch) {
								if (dName !== qName) continue;
							} else if (!dName.includes(qName)) continue;
						}

						rawResults.push(item);
					}

					allDefsByFile.set(relPath, fileDefs);
				} catch {
					// skip unreadable
				}
			}
		}
	}

	walk(rootDir);

	// Resolve aliased re-exports (e.g. `WebSocketClient` -> `client` in `.websocket`)
	const resolvedResults: AstQueryResult[] = [...rawResults];

	for (const hit of rawResults) {
		if (hit.kind === "alias" && hit.aliasedFrom) {
			const origName = hit.aliasedFrom.originalName;
			let foundOrig: AstQueryResult | null = null;

			// Check all parsed files for exact definition of `origName`
			for (const [fPath, defs] of allDefsByFile.entries()) {
				if (hit.aliasedFrom.module) {
					const cleanMod = hit.aliasedFrom.module
						.replace(/^\.+/, "")
						.replace(/::/g, "/")
						.replace(/\//g, ".");
					if (cleanMod && fPath.toLowerCase().includes(cleanMod.toLowerCase())) {
						const match = defs.find(
							(d) =>
								(d.name.toLowerCase() === origName.toLowerCase() ||
									d.name === origName) &&
								d.kind !== "alias",
						);
						if (match) {
							foundOrig = match;
							break;
						}
					}
				}
			}

			// Fallback: search across any file if not found by module hint
			if (!foundOrig) {
				for (const defs of allDefsByFile.values()) {
					const match = defs.find(
						(d) =>
							(d.name.toLowerCase() === origName.toLowerCase() ||
								d.name === origName) &&
							d.kind !== "alias",
					);
					if (match) {
						foundOrig = match;
						break;
					}
				}
			}

			if (foundOrig) {
				resolvedResults.push({
					filePath: foundOrig.filePath,
					name: hit.name,
					kind: foundOrig.kind,
					signature: foundOrig.signature,
							line: foundOrig.line,
							codeBlock: foundOrig.codeBlock,
							bodyTruncated: foundOrig.bodyTruncated,
							aliasedFrom: {
						module: `${hit.filePath}:${hit.line}`,
						originalName: origName,
					},
				});
			}
		}
	}

	// Sort results with multi-tier ranking
	resolvedResults.sort((a, b) => {
		const scoreA = computeSymbolRankScore(a, query.name, query.currentFilePath);
		const scoreB = computeSymbolRankScore(b, query.name, query.currentFilePath);
		return scoreA - scoreB;
	});

	// Deduplicate by filePath + line + name
	const seen = new Set<string>();
	const deduped: AstQueryResult[] = [];
	for (const item of resolvedResults) {
		const key = `${item.filePath}:${item.line}:${item.name}:${item.kind}`;
		if (!seen.has(key)) {
			seen.add(key);
			deduped.push(item);
		}
	}

	return deduped;
}
