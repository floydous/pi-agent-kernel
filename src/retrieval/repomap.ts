import * as fs from "node:fs";
import * as path from "node:path";
import { TreeSitterEngine } from "./tree_sitter_engine";

export interface SymbolDef {
	name: string;
	kind:
		| "function"
		| "class"
		| "interface"
		| "type"
		| "enum"
		| "variable"
		| "constant"
		| "method"
		| "alias";
	signature: string;
	line: number;
	endLine?: number;
	aliasedFrom?: {
		module?: string;
		originalName: string;
	};
}

export interface FileTags {
	filePath: string;
	definitions: SymbolDef[];
	references: Set<string>;
	hasSyntaxError?: boolean;
}

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	"coverage",
	".pi",
	".hermes",
	".next",
	".turbo",
	".cache",
	"target",
	"vendor",
]);

const SUPPORTED_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".rs",
	".go",
	".c",
	".cpp",
	".h",
	".hpp",
	".java",
	".cs",
	".rb",
	".php",
	".swift",
	".sh",
	".bash",
]);

// Helper to extract balanced signatures across multiple lines
function extractBalancedSig(
	lines: string[],
	startIdx: number,
	kind:
		| "function"
		| "class"
		| "interface"
		| "arrow"
		| "python_fn"
		| "python_class"
		| "rust_fn"
		| "rust_type"
		| "go_fn"
		| "go_type",
): string | null {
	let collected = "";
	let parenDepth = 0;
	let braceDepth = 0;
	let angleDepth = 0;
	let seenOpenParen = false;
	let seenArrow = false;

	for (let j = startIdx; j < Math.min(lines.length, startIdx + 20); j++) {
		const raw = lines[j];
		const trimmed = raw.trim();
		if (
			!trimmed ||
			(j > startIdx &&
				(trimmed.startsWith("//") ||
					trimmed.startsWith("#") ||
					trimmed.startsWith("/*") ||
					trimmed.startsWith("*")))
		)
			continue;

		for (let c = 0; c < trimmed.length; c++) {
			const ch = trimmed[c];
			const nextCh = trimmed[c + 1];

			if (ch === "(") {
				parenDepth++;
				seenOpenParen = true;
			} else if (ch === ")") {
				if (parenDepth > 0) parenDepth--;
			} else if (ch === "<") {
				angleDepth++;
			} else if (ch === ">") {
				if (angleDepth > 0) angleDepth--;
			} else if (ch === "{") {
				if (
					kind === "class" ||
					kind === "interface" ||
					kind === "rust_type" ||
					kind === "go_type"
				) {
					if (angleDepth === 0 && parenDepth === 0) {
						collected += (collected ? " " : "") + trimmed.slice(0, c);
						return collected.replace(/\s+/g, " ").trim();
					}
				} else if (kind === "function" || kind === "rust_fn" || kind === "go_fn") {
					if (parenDepth === 0 && angleDepth === 0) {
						collected += (collected ? " " : "") + trimmed.slice(0, c);
						return collected.replace(/\s+/g, " ").trim();
					}
				} else if (kind === "arrow") {
					if (seenArrow && parenDepth === 0 && angleDepth === 0) {
						collected += (collected ? " " : "") + trimmed.slice(0, c);
						return collected.replace(/\s+/g, " ").trim();
					}
				}
				braceDepth++;
			} else if (ch === "}") {
				if (braceDepth > 0) braceDepth--;
			} else if (ch === "=" && nextCh === ">") {
				seenArrow = true;
			} else if (ch === ";") {
				if (parenDepth === 0 && angleDepth === 0 && braceDepth === 0) {
					if (kind === "arrow") {
						if (!seenArrow && !collected.includes("=>")) return null;
						collected += (collected ? " " : "") + trimmed.slice(0, c);
						return collected.replace(/\s+/g, " ").trim();
					}
					if (
						kind === "function" ||
						kind === "rust_fn" ||
						kind === "rust_type" ||
						kind === "go_fn" ||
						kind === "go_type" ||
						kind === "class" ||
						kind === "interface"
					) {
						collected += (collected ? " " : "") + trimmed.slice(0, c);
						return collected.replace(/\s+/g, " ").trim();
					}
				}
			} else if (ch === ":" && (kind === "python_fn" || kind === "python_class")) {
				if (parenDepth === 0 && angleDepth === 0 && braceDepth === 0) {
					collected += (collected ? " " : "") + trimmed.slice(0, c);
					return collected.replace(/\s+/g, " ").trim();
				}
			}
		}

		if (kind === "arrow" && trimmed.includes(";")) {
			if (!seenArrow && !collected.includes("=>")) return null;
		}

		collected += (collected ? " " : "") + trimmed;
	}

	return null;
}

// Fast AST & Signature tag extractor with multi-line support
export function extractFileTags(filePath: string, content: string): FileTags {
	const tsEngine = TreeSitterEngine.getInstance();
	if (tsEngine.isSupported(filePath)) {
		const treeTags = tsEngine.extractTags(filePath, content);
		if (treeTags) {
			return treeTags;
		}
	}

	const ext = path.extname(filePath).toLowerCase();
	const lines = content.split("\n");
	const definitions: SymbolDef[] = [];
	const references = new Set<string>();
	let braceDepth = 0;

	// Extract identifier references (words matching [a-zA-Z_][a-zA-Z0-9_]*)
	const idRegex = /\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/g;
	let match: RegExpExecArray | null;
	while ((match = idRegex.exec(content)) !== null) {
		references.add(match[1]);
	}

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const line = rawLine.trim();
		if (
			!line ||
			line.startsWith("//") ||
			line.startsWith("#") ||
			line.startsWith("/*") ||
			line.startsWith("*")
		) {
			continue;
		}

		// TypeScript / JavaScript
		if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
			// function
			const fnStart = line.match(
				/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/,
			);
			if (fnStart) {
				const fullSig =
					extractBalancedSig(lines, i, "function") || line.split("{")[0].trim();
				definitions.push({
					name: fnStart[1],
					kind: "function",
					signature: fullSig.replace(/^export\s+/, ""),
					line: i + 1,
				});
				continue;
			}

			// class
			const classStart = line.match(
				/^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_]+)/,
			);
			if (classStart) {
				const fullSig =
					extractBalancedSig(lines, i, "class") || line.split("{")[0].trim();
				definitions.push({
					name: classStart[1],
					kind: "class",
					signature: fullSig.replace(/^export\s+/, ""),
					line: i + 1,
				});
				continue;
			}

			// interface
			const ifaceStart = line.match(/^(?:export\s+)?interface\s+([a-zA-Z0-9_]+)/);
			if (ifaceStart) {
				const fullSig =
					extractBalancedSig(lines, i, "interface") || line.split("{")[0].trim();
				definitions.push({
					name: ifaceStart[1],
					kind: "interface",
					signature: fullSig.replace(/^export\s+/, ""),
					line: i + 1,
				});
				continue;
			}

			// type alias
			const typeMatch = line.match(
				/^(?:export\s+)?type\s+([a-zA-Z0-9_]+)(?:<[^>]+>)?\s*=/,
			);
			if (typeMatch) {
				definitions.push({
					name: typeMatch[1],
					kind: "type",
					signature: `type ${typeMatch[1]}`,
					line: i + 1,
				});
				continue;
			}

			// const arrow function
			const constFnMatch = line.match(
				/^(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(/,
			);
			if (constFnMatch) {
				const fullSig = extractBalancedSig(lines, i, "arrow");
				if (fullSig && fullSig.includes("=>")) {
					definitions.push({
						name: constFnMatch[1],
						kind: "function",
						signature: fullSig.replace(/^export\s+/, ""),
						line: i + 1,
					});
					continue;
				}
			}

			// Class methods and accessors are the important cold-state fallback case.
			// Tree-sitter normally supplies these nested declarations; keep the
			// synchronous fallback useful before a grammar has been loaded.
			const tsJsGenericMethod = line.match(
				/^(?:(?:public|private|protected|static|abstract|override|readonly|async)\s+)*(?:[A-Za-z_$][\w$]*(?:<[^{};]*>)?\s+)*([A-Za-z_$][\w$]*)\s*<[^{};]*>\s*\([^{}]*\)\s*(?::\s*[^{};]+)?\s*\{/,
			);
			const tsJsMethod = tsJsGenericMethod || line.match(
				/^(?:(?:public|private|protected|static|abstract|override|readonly|async)\s+)*(?:[A-Za-z_$][\w$]*(?:<[^>]*>)?(?:\[\])?\??\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^={;]+)?(?:\{|;)/,
			);
			const controlOrExpression = /^(?:if|for|while|switch|catch|return|throw|await|new|super|this|const|let|var)\b/;
			const indentation = rawLine.match(/^\s*/)?.[0].length ?? 0;
			if (tsJsMethod && indentation > 0 && indentation <= 4 && !controlOrExpression.test(line)) {
				definitions.push({
					name: tsJsMethod[1],
					kind: "method",
					signature: line.split("{")[0].trim().replace(/;$/, ""),
					line: i + 1,
				});
				continue;
			}

			const tsJsAccessor = line.match(
				/^(?:(?:public|private|protected|static|abstract|override|readonly|async)\s+)*(?:get|set)\s+([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?\s*(?::\s*[^={;]+)?\s*(?:\{|;)/,
			);
			if (tsJsAccessor && indentation > 0 && indentation <= 4) {
				definitions.push({
					name: tsJsAccessor[1],
					kind: "method",
					signature: line.split("{")[0].trim().replace(/;$/, ""),
					line: i + 1,
				});
				continue;
			}

			// const variable / constant declaration: const FOO = ... or const FOO: string = ... (only top-level declarations)
			const constDecl = line.match(
				/^(?:export\s+)?const\s+([a-zA-Z0-9_]+)(?:\s*:\s*([^=]+))?\s*=/,
			);
			if (constDecl && braceDepth === 0 && rawLine === rawLine.trimStart()) {
				const isAllUpper = /^[A-Z0-9_]{2,}$/.test(constDecl[1]);
				definitions.push({
					name: constDecl[1],
					kind: isAllUpper ? "constant" : "variable",
					signature: line.replace(/;$/, "").trim(),
					line: i + 1,
				});
				continue;
			}

			// TS/JS Aliased re-exports and imports: import/export { a as b } from "./mod"
			if (
				(line.startsWith("import") || line.startsWith("export")) &&
				line.includes("{")
			) {
				let importBlock = line;
				if (!line.includes("}")) {
					const collected: string[] = [];
					for (let j = i; j < Math.min(lines.length, i + 10); j++) {
						collected.push(lines[j].trim());
						if (lines[j].includes("}")) break;
					}
					importBlock = collected.join(" ");
				}
				const modMatch = importBlock.match(/from\s*['"]([^'"]+)['"]/);
				const mod = modMatch ? modMatch[1] : undefined;
				const innerMatch = importBlock.match(/\{([^}]+)\}/);
				if (innerMatch) {
					const rawItems = innerMatch[1].split(",");
					for (const item of rawItems) {
						const trimmed = item.trim();
						const asMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+as\s+([a-zA-Z0-9_]+)$/);
						if (asMatch) {
							definitions.push({
								name: asMatch[2],
								kind: "alias",
								signature: `import { ${asMatch[1]} as ${asMatch[2]} } from "${mod || ""}"`,
								line: i + 1,
								aliasedFrom: { module: mod, originalName: asMatch[1] },
							});
						}
					}
				}
			}

			// TS/JS import/export * as alias
			const starAsMatch = line.match(
				/^(?:export|import)\s*\*\s*as\s+([a-zA-Z0-9_]+)\s*from\s*['"]([^'"]+)['"]/,
			);
			if (starAsMatch) {
				definitions.push({
					name: starAsMatch[1],
					kind: "alias",
					signature: line,
					line: i + 1,
					aliasedFrom: { module: starAsMatch[2], originalName: starAsMatch[1] },
				});
			}
		}

		// Python
		if (ext === ".py") {
			// def (with multi-line signature support)
			const pyFnStart = line.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)/);
			if (pyFnStart) {
				const isMethod = rawLine.startsWith("    ") || rawLine.startsWith("\t");
				const sig = (extractBalancedSig(lines, i, "python_fn") || line)
					.replace(/:$/, "")
					.trim();
				definitions.push({
					name: pyFnStart[1],
					kind: isMethod ? "method" : "function",
					signature: sig,
					line: i + 1,
				});
				continue;
			}

			// class (with multi-line base class support)
			const pyClassStart = line.match(/^class\s+([a-zA-Z0-9_]+)/);
			if (pyClassStart) {
				const sig = (extractBalancedSig(lines, i, "python_class") || line)
					.replace(/:$/, "")
					.trim();
				definitions.push({
					name: pyClassStart[1],
					kind: "class",
					signature: sig,
					line: i + 1,
				});
				continue;
			}

			// Python import with alias: `from .mod import ( ... )` or `from .mod import a as b`
			if (line.startsWith("from ") && line.includes("import")) {
				let importBlock = line;
				if (line.includes("(") && !line.includes(")")) {
					const collected: string[] = [];
					for (let j = i; j < Math.min(lines.length, i + 10); j++) {
						collected.push(lines[j].trim());
						if (lines[j].includes(")")) break;
					}
					importBlock = collected.join(" ");
				}
				const fromModMatch = importBlock.match(
					/^from\s+([.\w]+)\s+import\s+(?:\(([^)]+)\)|(.+))$/,
				);
				if (fromModMatch) {
					const mod = fromModMatch[1];
					const rawItems = (fromModMatch[2] || fromModMatch[3] || "").split(",");
					for (const item of rawItems) {
						const trimmed = item.trim();
						if (!trimmed) continue;
						const asMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+as\s+([a-zA-Z0-9_]+)$/);
						if (asMatch) {
							definitions.push({
								name: asMatch[2],
								kind: "alias",
								signature: `from ${mod} import ${asMatch[1]} as ${asMatch[2]}`,
								line: i + 1,
								aliasedFrom: { module: mod, originalName: asMatch[1] },
							});
						}
					}
				}
			}

			// Python module alias: import websocket as ws
			const pyImportAs = line.match(/^import\s+([.\w]+)\s+as\s+([a-zA-Z0-9_]+)/);
			if (pyImportAs) {
				definitions.push({
					name: pyImportAs[2],
					kind: "alias",
					signature: line,
					line: i + 1,
					aliasedFrom: { module: pyImportAs[1], originalName: pyImportAs[1] },
				});
			}

			// Python top-level assignment alias: WebSocketClient = client
			const pyAssignAlias = line.match(/^([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)$/);
			if (
				pyAssignAlias &&
				!rawLine.startsWith(" ") &&
				!rawLine.startsWith("\t") &&
				!pyAssignAlias[1].startsWith("__")
			) {
				definitions.push({
					name: pyAssignAlias[1],
					kind: "alias",
					signature: line,
					line: i + 1,
					aliasedFrom: { originalName: pyAssignAlias[2] },
				});
			}

			// Python top-level constant / variable assignment (e.g. TIMEOUT = 30 or MAX_RETRIES: int = 5)
			const pyConstMatch = line.match(/^([A-Z0-9_]{2,})(?:\s*:\s*([^=]+))?\s*=/);
			if (
				pyConstMatch &&
				!rawLine.startsWith(" ") &&
				!rawLine.startsWith("\t") &&
				!pyConstMatch[1].startsWith("__")
			) {
				definitions.push({
					name: pyConstMatch[1],
					kind: "constant",
					signature: line.trim(),
					line: i + 1,
				});
				continue;
			}
		}

		// Rust
		if (ext === ".rs") {
			// fn / async fn / method
			const rsFn = line.match(
				/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([a-zA-Z0-9_]+)/,
			);
			if (rsFn) {
				const isMethod = rawLine.startsWith("    ") || rawLine.startsWith("\t");
				const sig =
					extractBalancedSig(lines, i, "rust_fn") || line.split("{")[0].trim();
				definitions.push({
					name: rsFn[1],
					kind: isMethod ? "method" : "function",
					signature: sig,
					line: i + 1,
				});
				continue;
			}

			// struct / enum / trait
			const rsStruct = line.match(
				/^(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait)\s+([a-zA-Z0-9_]+)/,
			);
			if (rsStruct) {
				const sig =
					extractBalancedSig(lines, i, "rust_type") || line.split("{")[0].trim();
				definitions.push({
					name: rsStruct[2],
					kind: rsStruct[1] as "class",
					signature: sig,
					line: i + 1,
				});
				continue;
			}

			// static / const
			const rsStatic = line.match(
				/^(?:pub(?:\([^)]+\))?\s+)?(static|const)\s+(?:mut\s+)?([a-zA-Z0-9_]+)\s*:\s*([^=;]+)/,
			);
			if (rsStatic) {
				const kind = rsStatic[1] === "const" ? "constant" : "variable";
				definitions.push({
					name: rsStatic[2],
					kind,
					signature: line.replace(/;$/, "").trim(),
					line: i + 1,
				});
				continue;
			}

			// type alias
			const rsType = line.match(
				/^(?:pub(?:\([^)]+\))?\s+)?type\s+([a-zA-Z0-9_]+)(?:<[^>]+>)?\s*=/,
			);
			if (rsType) {
				definitions.push({
					name: rsType[1],
					kind: "type",
					signature: line.replace(/;$/, "").trim(),
					line: i + 1,
				});
				continue;
			}
		}

		// Go
		if (ext === ".go") {
			const goFn = line.match(/^func\s+(\([^)]+\)\s+)?([a-zA-Z0-9_]+)/);
			if (goFn) {
				const sig =
					extractBalancedSig(lines, i, "go_fn") || line.split("{")[0].trim();
				definitions.push({
					name: goFn[2],
					kind: goFn[1] ? "method" : "function",
					signature: sig,
					line: i + 1,
				});
				continue;
			}

			const goType = line.match(/^type\s+([a-zA-Z0-9_]+)\s+(.+)/);
			if (goType) {
				const typeBody = goType[2].trim();
				const sig =
					extractBalancedSig(lines, i, "go_type") ||
					line.replace(/\s*\{\s*$/, "").trim();
				definitions.push({
					name: goType[1],
					kind: typeBody.startsWith("interface") ? "interface" : "class",
					signature: sig,
					line: i + 1,
				});
				continue;
			}

			// const / var
			const goConst = line.match(/^(?:const|var)\s+([a-zA-Z0-9_]+)(?:\s+([^=]+))?\s*=/);
			if (goConst) {
				const isConst = line.startsWith("const");
				definitions.push({
					name: goConst[1],
					kind: isConst ? "constant" : "variable",
					signature: line.trim(),
					line: i + 1,
				});
				continue;
			}
		}

		// Java / C# / C++ fallback regex scanner when TreeSitter is cold
		if (ext === ".java" || ext === ".cs") {
			// Methods may be expression-bodied (`... FindById(...) => ...`) and
			// therefore have no opening brace for the balanced-signature helper.
			const expressionMethod = line.match(
				/^(?:public|private|protected|internal|static|final|synchronized|async|virtual|override|sealed|readonly|new|partial|unsafe|extern|\s)+\s+([A-Za-z0-9_<>,.?\[\]\s]+?)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*=>/,
			);
			if (expressionMethod) {
				definitions.push({
					name: expressionMethod[2],
					kind: "method",
					signature: line.split("=>")[0].trim(),
					line: i + 1,
				});
				continue;
			}

			// Class / interface / enum
			const jClass = line.match(
				/^(?:public|private|protected|internal|abstract|static|final|\s)*\s*(class|interface|enum)\s+([a-zA-Z0-9_]+)/,
			);
			if (jClass) {
				definitions.push({
					name: jClass[2],
					kind: jClass[1] === "interface" ? "interface" : jClass[1] === "enum" ? "enum" : "class",
					signature: line.split("{")[0].trim(),
					line: i + 1,
				});
				continue;
			}

			// Method (requires return type and parentheses)
			const jMethod = line.match(
				/^(?:public|private|protected|internal|static|final|synchronized|async|virtual|override|\s)+\s+([a-zA-Z0-9_<>\[\],\s]+)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/,
			);
			if (jMethod && !jMethod[1].includes("class") && !jMethod[1].includes("return")) {
				definitions.push({
					name: jMethod[2],
					kind: "method",
					signature: line.split("{")[0].trim(),
					line: i + 1,
				});
				continue;
			}
		}

		// C / C++
		if (ext === ".c" || ext === ".cpp" || ext === ".cc" || ext === ".h" || ext === ".hpp") {
			const cExpressionFn = line.match(
				/^(?:[A-Za-z_][A-Za-z0-9_:<>*&\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/,
			);
			if (cExpressionFn && !cExpressionFn[1].match(/^(if|for|while|switch|return)$/)) {
				definitions.push({
					name: cExpressionFn[1],
					kind: rawLine !== rawLine.trimStart() ? "method" : "function",
					signature: line.split("{")[0].trim(),
					line: i + 1,
				});
				continue;
			}

			const cClass = line.match(/^(?:class|struct)\s+([a-zA-Z0-9_]+)/);
			if (cClass) {
				definitions.push({
					name: cClass[1],
					kind: "class",
					signature: line.split("{")[0].trim(),
					line: i + 1,
				});
				continue;
			}

			const cFn = line.match(
				/^(?:[a-zA-Z0-9_&*]+\s+)+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*(?:const)?\s*[{;]?$/,
			);
			if (cFn && !cFn[1].match(/^(if|for|while|switch|return)$/)) {
				definitions.push({
					name: cFn[1],
					kind: rawLine !== rawLine.trimStart() ? "method" : "function",
					signature: line.split("{")[0].trim(),
					line: i + 1,
				});
				continue;
			}
		}

		// Ruby
		if (ext === ".rb") {
			const rbClass = line.match(/^(?:class|module)\s+([a-zA-Z0-9_:]+)/);
			if (rbClass) {
				definitions.push({
					name: rbClass[1],
					kind: "class",
					signature: line.trim(),
					line: i + 1,
				});
				continue;
			}

			const rbMethod = line.match(/^\s*def\s+([a-zA-Z0-9_!?=.]+)/);
			if (rbMethod) {
				definitions.push({
					name: rbMethod[1],
					kind: "method",
					signature: line.trim(),
					line: i + 1,
				});
				continue;
			}
		}

		// PHP
		if (ext === ".php") {
			const phpClass = line.match(/^(?:abstract\s+|final\s+)?(class|interface|trait)\s+([a-zA-Z0-9_]+)/);
			if (phpClass) {
				definitions.push({
					name: phpClass[2],
					kind: phpClass[1] === "interface" ? "interface" : "class",
					signature: line.split("{")[0].trim(),
					line: i + 1,
				});
				continue;
			}

			const phpFn = line.match(/^(?:public|private|protected|static|\s)*function\s+([a-zA-Z0-9_]+)\s*\(/);
			if (phpFn) {
				definitions.push({
					name: phpFn[1],
					kind: braceDepth > 0 ? "method" : "function",
					signature: line.split("{")[0].trim(),
					line: i + 1,
				});
				continue;
			}
		}

		// Bash / Shell
		if (ext === ".sh" || ext === ".bash") {
			const shFn = line.match(/^(?:function\s+)?([a-zA-Z0-9_]+)\s*\(\)\s*\{?/);
			if (shFn) {
				definitions.push({
					name: shFn[1],
					kind: "function",
					signature: `${shFn[1]}()`,
					line: i + 1,
				});
				continue;
			}
		}

		for (const ch of line) {
			if (ch === "{") braceDepth++;
			else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
		}
	}

	return {
		filePath,
		definitions,
		references,
	};
}

// Recursively find all supported code files in a directory
export function findSourceFiles(rootDir: string, maxFiles = 300): string[] {
	const results: string[] = [];

	function scan(dir: string) {
		if (results.length >= maxFiles) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			if (IGNORED_DIRS.has(entry.name)) continue;

			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				scan(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (SUPPORTED_EXTENSIONS.has(ext)) {
					results.push(fullPath);
					if (results.length >= maxFiles) return;
				}
			}
		}
	}

	scan(rootDir);
	return results;
}

// Classify a file path into a PageRank demotion factor. Test suites form
// dense mutual-reference clusters that otherwise dominate raw PageRank —
// mirrors the test-path penalties in ast_search.computeSymbolRankScore.
function getPathDemotion(relPath: string): number {
	const p = relPath.replace(/\\/g, "/").toLowerCase();
	const isTestPath =
		p.includes("/test/") ||
		p.includes("/tests/") ||
		p.includes("/__tests__/") ||
		p.includes("/spec/") ||
		p.includes("/specs/") ||
		p.startsWith("test/") ||
		p.startsWith("tests/") ||
		p.startsWith("spec/") ||
		p.includes("test_") ||
		p.includes("_test.") ||
		p.includes(".test.") ||
		p.includes(".spec.");
	if (isTestPath) return 0.25; // strong demotion
	const isBenchmarkOrExample =
		p.includes("/benchmarks/") ||
		p.includes("/benchmark/") ||
		p.includes("/examples/") ||
		p.includes("/example/") ||
		p.includes("/samples/") ||
		p.includes("/fixtures/") ||
		p.startsWith("benchmarks/") ||
		p.startsWith("examples/") ||
		p.startsWith("samples/");
	if (isBenchmarkOrExample) return 0.6; // moderate demotion
	return 1;
}

function isTrivialDataDefinition(def: SymbolDef): boolean {
	if (def.kind !== "constant" && def.kind !== "variable") return false;
	const signature = def.signature.toLowerCase();
	return (
		signature.includes("color::rgb") ||
		signature.includes("lazylock") ||
		signature.includes("regex") ||
		signature.includes("hashset") ||
		signature.includes("mimetype") ||
		signature.includes("mime") ||
		signature.includes("once_lock") ||
		signature.includes("mutex") ||
		(signature.includes("static") && signature.includes("table"))
	);
}

/**
 * Return a stable orientation priority for common executable and routing
 * anchors. PageRank is still used for the rest of the map, but declaration
 * density must not hide the entry point behind UI palette constants.
 */
function entryPointPriority(relPath: string, def: SymbolDef): number | null {
	const normalizedPath = relPath.replace(/\\/g, "/").toLowerCase();
	const fileName = path.basename(normalizedPath, path.extname(normalizedPath));
	const name = def.name.toLowerCase();

	if (name === "main") return 0;
	if (name === "router") return 1;
	if (name === "startup" || name === "start") return 2;
	if (fileName === "main" && (def.kind === "function" || def.kind === "method")) return 3;
	if ((fileName === "index" || fileName === "mod") && name === "createapp") return 4;
	if (name === "run" && (normalizedPath.includes("/bin/") || normalizedPath.includes("/cmd/"))) return 5;
	return null;
}

// Compute Graph PageRank for files and their symbols
export function computeRepoMap(rootDir: string, tokenBudget = 1024): string {
	const sourceFiles = findSourceFiles(rootDir);
	if (sourceFiles.length === 0) {
		return "(No supported source files found in repository)";
	}

	// Ensure languages present in sourceFiles are loaded in TreeSitterEngine
	const detectedExts = new Set<string>();
	for (const f of sourceFiles) {
		const ext = path.extname(f).toLowerCase();
		if (ext) detectedExts.add(ext);
	}
	// Note: loadLanguages is async, but if called from an async context it is pre-warmed.
	// We also trigger loadLanguages asynchronously if not loaded.
	void TreeSitterEngine.getInstance().loadLanguages(Array.from(detectedExts));

	const fileTagsMap = new Map<string, FileTags>();
	const fileLineCounts = new Map<string, number>();
	const defToFile = new Map<string, Set<string>>();

	for (const file of sourceFiles) {
		try {
			const content = fs.readFileSync(file, "utf8");
			const tags = extractFileTags(file, content);
			fileTagsMap.set(file, tags);
			fileLineCounts.set(file, content.split("\n").length);

			for (const def of tags.definitions) {
				if (!defToFile.has(def.name)) {
					defToFile.set(def.name, new Set());
				}
				defToFile.get(def.name)!.add(file);
			}
		} catch {
			// Skip unreadable files
		}
	}

	// Build adjacency graph between files
	const files = Array.from(fileTagsMap.keys());
	const N = files.length;
	if (N === 0) return "(Empty repository)";

	const fileIndex = new Map<string, number>();
	files.forEach((f, idx) => fileIndex.set(f, idx));

	const inEdges: number[][] = Array.from({ length: N }, () => []);
	const outDegree = new Array(N).fill(0);

	for (let i = 0; i < N; i++) {
		const fileA = files[i];
		const tagsA = fileTagsMap.get(fileA)!;
		const referencedFiles = new Set<number>();

		for (const ref of tagsA.references) {
			const targetFiles = defToFile.get(ref);
			if (targetFiles) {
				for (const targetFile of targetFiles) {
					const targetIdx = fileIndex.get(targetFile);
					if (targetIdx !== undefined && targetIdx !== i) {
						referencedFiles.add(targetIdx);
					}
				}
			}
		}

		outDegree[i] = referencedFiles.size;
		for (const targetIdx of referencedFiles) {
			inEdges[targetIdx].push(i);
		}
	}

	// PageRank iteration (d = 0.85)
	const d = 0.85;
	let rank = new Array(N).fill(1 / N);

	for (let iter = 0; iter < 15; iter++) {
		const nextRank = new Array(N).fill((1 - d) / N);
		for (let i = 0; i < N; i++) {
			let sum = 0;
			for (const src of inEdges[i]) {
				if (outDegree[src] > 0) {
					sum += rank[src] / outDegree[src];
				}
			}
			nextRank[i] += d * sum;
		}
		rank = nextRank;
	}

	// Sort files by anchor priority first, then effective PageRank. This keeps
	// executable/router entry points visible on cold start while retaining the
	// graph ranking for the rest of the repository.
	const rankedFiles = files
		.map((f, idx) => {
			const relPath = path.relative(rootDir, f).replace(/\\/g, "/");
			const tags = fileTagsMap.get(f)!;
			const anchorPriorities = tags.definitions
				.map((def) => entryPointPriority(relPath, def))
				.filter((priority): priority is number => priority !== null);
			return {
				file: f,
				effectiveRank: rank[idx] * getPathDemotion(relPath),
				tags,
				anchorPriority: anchorPriorities.length > 0 ? Math.min(...anchorPriorities) : Number.POSITIVE_INFINITY,
			};
		})
		.sort((a, b) =>
			a.anchorPriority - b.anchorPriority || b.effectiveRank - a.effectiveRank,
		);

	// Pack symbols into token budget (~4 chars per token).
	const charBudget = Math.max(80, tokenBudget * 4);
	let currentChars = 0;
	const lines: string[] = [];
	const addLine = (line: string): boolean => {
		const extra = lines.length > 0 ? 1 : 0;
		if (currentChars + extra + line.length > charBudget) return false;
		lines.push(line);
		currentChars += extra + line.length;
		return true;
	};

	addLine("Repository Map (Tree-Sitter AST & PageRank Ranked):");

	// A compact orientation strip gives a cold-start caller the files it is most
	// likely to need without requiring a separate `ls`/`wc` shell round trip.
	if (charBudget >= 512) {
		const anchors = rankedFiles
			.flatMap((item) => {
				const relPath = path.relative(rootDir, item.file).replace(/\\/g, "/");
				return item.tags.definitions
					.map((def) => ({ def, priority: entryPointPriority(relPath, def), relPath }))
					.filter((entry): entry is { def: SymbolDef; priority: number; relPath: string } => entry.priority !== null);
			})
			.sort((a, b) => a.priority - b.priority)
			.slice(0, 8)
			.map((entry) => `${entry.relPath}::${entry.def.name}`);
		if (anchors.length > 0) addLine(`Entry points: ${anchors.join(", ")}`);
	}

	if (charBudget >= 1024) {
		const sizeList = files
			.slice()
			.sort((a, b) => (fileLineCounts.get(b) || 0) - (fileLineCounts.get(a) || 0))
			.slice(0, 12)
			.map((file) => `${path.relative(rootDir, file).replace(/\\/g, "/")}(${fileLineCounts.get(file) || 0})`);
		if (sizeList.length > 0) addLine(`Files by size: ${sizeList.join(", ")}`);
	}

	for (const item of rankedFiles) {
		const relPath = path.relative(rootDir, item.file).replace(/\\/g, "/");
		const fileHeader = `${relPath}:`;
		if (currentChars + fileHeader.length + 1 > charBudget) break;

		const nonAliasDefs = item.tags.definitions.filter((d) => d.kind !== "alias");
		const meaningfulDefs = nonAliasDefs.filter((d) => !isTrivialDataDefinition(d));
		const defs = meaningfulDefs.length > 0 ? meaningfulDefs : nonAliasDefs;
		if (defs.length === 0) continue;

		if (!addLine(fileHeader)) break;
		for (const def of defs) {
			const cleanSig = def.signature.replace(/\s+/g, " ").trim();
			const sigLine = `  ${cleanSig}`;
			if (!addLine(sigLine)) break;
		}
	}

	// A bare header with nothing under it gives the caller zero guidance —
	// say why the map is empty and how to get useful output.
	if (lines.length === 1) {
		lines.push("");
		lines.push(
			`[No symbols fit within budget_tokens=${tokenBudget} (~${charBudget} chars). Increase 'budget_tokens' (e.g. 1024+) to see the ranked symbol map.]`,
		);
	}

	return lines.join("\n");
}
