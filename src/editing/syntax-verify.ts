import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export interface VerificationResult {
	valid: boolean;
	status?: "clean" | "failed" | "unavailable" | "inconclusive";
	error?: string;
}

/**
 * Structural syntax validation for TypeScript/JSX files.
 *
 * `node --check` cannot parse TS and a full `tsc` parse is too slow for a
 * per-edit gate, so this strips comments and string/template literals
 * (respecting escapes) and verifies that all delimiters — ( ) [ ] { } — are
 * balanced. This deterministically catches the dominant per-edit failure
 * class: truncated replacements, missing closing braces/parens, unterminated
 * strings or block comments. It is NOT a full parse; type errors remain the
 * job of the post-edit LSP diagnostics hook.
 */
/**
 * Decides whether a '/' at the current position starts a regex literal
 * rather than a division operator. Standard lexer heuristic:
 * - right after certain keywords (return /re/, typeof /re/, ...) -> regex
 * - right after any other identifier/number -> division (x / 2)
 * - right after ')', ']', '}', '.', or a closing quote -> division
 * - anywhere else (start of file, after operators, '(', '=', ',', etc.)
 *   -> regex
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

function regexCanStart(prevSig: string, lastWord: string): boolean {
	if (lastWord) return REGEX_PRECEDING_KEYWORDS.has(lastWord);
	if (prevSig === "") return true;
	return !")]}\"'`.".includes(prevSig);
}

function checkTsStructure(content: string): string | null {
	const stack: { ch: string; line: number }[] = [];
	let line = 1;
	let i = 0;
	// State machine over raw source: code | 'str' | "str" | `tpl` | //line | /*block */ | /regex/
	type State =
		| "code"
		| "squote"
		| "dquote"
		| "template"
		| "lineComment"
		| "blockComment"
		| "regex";
	let state: State = "code";
	// Inside a regex character class [...], '/' does not terminate the regex.
	let inCharClass = false;
	// Last significant (non-whitespace) char seen in code state — used to
	// decide whether a '/' starts a regex literal or is a division operator.
	let prevSig = "";
	// Current identifier/number token being scanned (for keyword detection).
	let lastWord = "";
	const closers: Record<string, string> = {
		")": "(",
		"]": "[",
		"}": "{",
	};

	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];
		if (ch === "\n") {
			line++;
			if (state === "lineComment") state = "code";
			i++;
			continue;
		}

		switch (state) {
			case "lineComment":
				break;
			case "blockComment":
				if (ch === "*" && next === "/") {
					state = "code";
					i++;
				}
				break;
			case "squote":
				if (ch === "\\") i++;
				else if (ch === "'") state = "code";
				break;
			case "dquote":
				if (ch === "\\") i++;
				else if (ch === '"') state = "code";
				break;
			case "template":
				if (ch === "\\") i++;
				else if (ch === "`") state = "code";
				// NOTE: ${...} interpolations are tracked as part of the template
				// body; braces inside them are balanced by JS itself, and any
				// imbalance surfaces as an unbalanced delimiter anyway.
				break;
			case "code":
				if (ch === "/" && next === "/") {
					state = "lineComment";
					i++;
				} else if (ch === "/" && next === "*") {
					state = "blockComment";
					i++;
				} else if (ch === "/" && regexCanStart(prevSig, lastWord)) {
					// Regex literal (division makes no sense at this position).
					// Delimiters inside it are pattern syntax, not code structure.
					state = "regex";
					inCharClass = false;
					lastWord = "";
				} else if (ch === "'") {
					state = "squote";
					prevSig = "'";
					lastWord = "";
				} else if (ch === '"') {
					state = "dquote";
					prevSig = '"';
					lastWord = "";
				} else if (ch === "`") {
					state = "template";
					prevSig = "`";
					lastWord = "";
				} else if (ch === "(" || ch === "[" || ch === "{") {
					stack.push({ ch, line });
				} else if (ch === ")" || ch === "]" || ch === "}") {
					const top = stack.pop();
					if (!top || top.ch !== closers[ch]) {
						return `Unbalanced '${ch}' on line ${line}${top ? ` (unclosed '${top.ch}' from line ${top.line})` : " (no matching opener)"}`;
					}
				}
				if (!/\s/.test(ch)) prevSig = ch;
				// Accumulate identifier/number tokens; whitespace preserves the
				// token (so 'return /re/' and 'x / 2' both resolve correctly),
				// while any other character ends it.
				if (/\s/.test(ch)) {
					// keep lastWord
				} else if (/[A-Za-z0-9_$]/.test(ch)) {
					lastWord += ch;
				} else {
					lastWord = "";
				}
				break;
			case "regex":
				if (ch === "\\") i++;
				else if (ch === "[") inCharClass = true;
				else if (ch === "]") inCharClass = false;
				else if (ch === "/" && !inCharClass) state = "code";
				break;
		}
		i++;
	}

	if (state === "squote" || state === "dquote" || state === "template") {
		return `Unterminated string literal (reached end of file, last line ${line})`;
	}
	if (state === "blockComment") {
		return `Unterminated block comment (last line ${line})`;
	}
	if (stack.length > 0) {
		const unclosed = stack[stack.length - 1];
		return `Unclosed '${unclosed.ch}' opened on line ${unclosed.line} (still open at end of file)`;
	}
	return null;
}

function validateSyntaxAtPath(resolvedPath: string): VerificationResult {
	if (!fs.existsSync(resolvedPath)) {
		return { valid: true, status: "clean" };
	}

	const ext = path.extname(resolvedPath).toLowerCase();

	try {
		if (ext === ".py") {
			try {
				execFileSync("python", ["-m", "py_compile", resolvedPath], {
					stdio: "pipe",
					timeout: 5000,
				});
			} catch (error: any) {
				const unavailable = error?.code === "ENOENT" || error?.status === 9009;
				if (!unavailable) throw error;
				try {
					execFileSync("python3", ["-m", "py_compile", resolvedPath], {
						stdio: "pipe",
						timeout: 5000,
					});
				} catch (fallbackError: any) {
					if (fallbackError?.code === "ENOENT" || fallbackError?.status === 9009) {
						return {
							valid: false,
							status: "unavailable",
							error: "Python runtime unavailable",
						};
					}
					throw fallbackError;
				}
			}
		} else if (ext === ".json") {
			const content = fs.readFileSync(resolvedPath, "utf8");
			JSON.parse(content);
		} else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
			execFileSync(process.execPath, ["--check", resolvedPath], {
				stdio: "pipe",
				timeout: 5000,
			});
		} else if (
			ext === ".ts" ||
			ext === ".tsx" ||
			ext === ".jsx" ||
			ext === ".mts" ||
			ext === ".cts"
		) {
			const tsContent = fs.readFileSync(resolvedPath, "utf8");
			const structuralError = checkTsStructure(tsContent);
			if (structuralError) throw new Error(structuralError);

			const compiler = path.resolve(
				__dirname,
				"../../node_modules/typescript/bin/tsc",
			);
			const compilerArgs = [
				"--noEmit",
				"--noCheck",
				"--noResolve",
				"--skipLibCheck",
				"--pretty",
				"false",
				"--target",
				"ES2020",
				"--module",
				"CommonJS",
				...(ext === ".tsx" || ext === ".jsx"
					? ["--jsx", "preserve", "--allowJs"]
					: []),
				resolvedPath,
			];
			try {
				execFileSync(process.execPath, [compiler, ...compilerArgs], {
					stdio: "pipe",
					timeout: 5000,
				});
			} catch (error: any) {
				if (error?.code === "ENOENT" || error?.status === 9009) {
					return {
						valid: false,
						status: "unavailable",
						error: "TypeScript compiler unavailable",
					};
				}
				throw error;
			}
		} else {
			return {
				valid: false,
				status: "unavailable",
				error: `No syntax validator is available for '${ext || "this file type"}'.`,
			};
		}
		return { valid: true, status: "clean" };
	} catch (err: any) {
		const stderr = err.stderr?.toString?.() || "";
		const stdout = err.stdout?.toString?.() || "";
		const output = stderr || stdout || err.message || String(err);
		return {
			valid: false,
			status: "failed",
			error: `Syntax validation failed on ${path.basename(resolvedPath)}:\n${output}`,
		};
	}
}

export function checkSyntax(filePath: string): VerificationResult {
	const resolvedPath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	return validateSyntaxAtPath(resolvedPath);
}

/**
 * Validate candidate content without changing the target file.
 * File-oriented validators run against a temporary sibling with the same
 * extension, which keeps their existing behavior while protecting the target.
 */
export function checkSyntaxContent(
	filePath: string,
	content: string,
): VerificationResult {
	const resolvedPath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	const extension = path.extname(resolvedPath) || ".tmp";
	let tempDir: string | undefined;

	try {
		tempDir = fs.mkdtempSync(
			path.join(path.dirname(resolvedPath), ".pi-agent-kernel-validate-"),
		);
		const candidatePath = path.join(tempDir, `candidate${extension}`);
		fs.writeFileSync(candidatePath, content, "utf8");
		return validateSyntaxAtPath(candidatePath);
	} catch (err: any) {
		return {
			valid: false,
			status: "inconclusive",
			error: `Syntax validation could not inspect candidate content: ${err.message || String(err)}`,
		};
	} finally {
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; the validation result remains explicit.
			}
		}
	}
}
