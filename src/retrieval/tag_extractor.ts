import * as path from "node:path";
import { TreeSitterEngine } from "./tree_sitter_engine";
import { walkWorkspaceFiles } from "./workspace_walker";

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
		| "alias"
		| "test";
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
				let kind: "class" | "interface" | "enum" = "class";
				if (jClass[1] === "interface") kind = "interface";
				else if (jClass[1] === "enum") kind = "enum";
				definitions.push({
					name: jClass[2],
					kind,
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
	return walkWorkspaceFiles({
		rootDir,
		maxFiles,
		extensions: SUPPORTED_EXTENSIONS,
		includeGithub: false,
	});
}

// Check if a path corresponds to a test file or test directory
export function isTestPath(relPath: string): boolean {
	const p = relPath.replace(/\\/g, "/").toLowerCase();
	return (
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
		p.includes(".spec.")
	);
}
