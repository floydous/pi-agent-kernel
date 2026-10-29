import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { TreeSitterEngine } from "../retrieval/tree_sitter_engine";

export interface VerificationResult {
	valid: boolean;
	status?: "clean" | "failed" | "unavailable" | "inconclusive" | "not run";
	error?: string;
}

let cachedNodeExec: { bin: string; env?: Record<string, string> } | null | undefined;

export function resolveNodeExecutable(): { bin: string; env?: Record<string, string> } | null {
	if (cachedNodeExec !== undefined) return cachedNodeExec;

	const candidates: { bin: string; env?: Record<string, string> }[] = [];

	if (process.versions?.electron) {
		candidates.push({ bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } });
	}
	candidates.push({ bin: process.execPath });
	candidates.push({ bin: "node" });

	for (const cand of candidates) {
		try {
			const env = cand.env ? { ...process.env, ...cand.env } : process.env;
			const res = execFileSync(cand.bin, ["-e", "process.stdout.write(process.versions.node || '')"], {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
				env,
				encoding: "utf8",
			});
			if (res && res.trim()) {
				cachedNodeExec = cand;
				return cand;
			}
		} catch (error) {
			void error;
		}
	}

	cachedNodeExec = null;
	return null;
}

export function resetNodeExecutableCache(): void {
	cachedNodeExec = undefined;
}

export function setNodeExecutableForTesting(
	nodeExec: { bin: string; env?: Record<string, string> } | null | undefined,
): void {
	cachedNodeExec = nodeExec;
}

export function resolveTypeScriptCompiler(): string {
  try {
    return path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  } catch {
    // Compatibility fallback for unusual loaders that do not expose require.resolve.
    return path.resolve(__dirname, "../../node_modules/typescript/bin/tsc");
  }
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
			const nodeExec = resolveNodeExecutable();
			if (!nodeExec) {
				return {
					valid: true,
					status: "unavailable",
					error: "Node runtime unavailable for syntax verification",
				};
			}
			try {
				execFileSync(nodeExec.bin, ["--check", resolvedPath], {
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 5000,
					env: nodeExec.env ? { ...process.env, ...nodeExec.env } : process.env,
				});
			} catch (error: any) {
				const stderr = error?.stderr?.toString?.() || "";
				const stdout = error?.stdout?.toString?.() || "";
				const output = (stderr || stdout || error?.message || "").trim();
				if (
					output.includes("SyntaxError") ||
					output.includes("Unexpected token") ||
					output.includes("Parsing error")
				) {
					return {
						valid: false,
						status: "failed",
						error: `Syntax validation failed on ${path.basename(resolvedPath)}:\n${output}`,
					};
				}
				return {
					valid: true,
					status: "unavailable",
					error: output || "Node syntax check unavailable",
				};
			}
		} else if (
			ext === ".ts" ||
			ext === ".tsx" ||
			ext === ".jsx" ||
			ext === ".mts" ||
			ext === ".cts"
		) {
			const nodeExec = resolveNodeExecutable();
			const compiler = resolveTypeScriptCompiler();
			if (!nodeExec || !fs.existsSync(compiler)) {
				return {
					valid: true,
					status: "unavailable",
					error: "TypeScript compiler unavailable",
				};
			}

			const compilerArgs = [
				"--noEmit",
				"--noCheck",
				"--noResolve",
				"--skipLibCheck",
				"--ignoreConfig",
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
				execFileSync(nodeExec.bin, [compiler, ...compilerArgs], {
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 5000,
					env: nodeExec.env ? { ...process.env, ...nodeExec.env } : process.env,
				});
			} catch (error: any) {
				const stderr = error?.stderr?.toString?.() || "";
				const stdout = error?.stdout?.toString?.() || "";
				const output = (stderr || stdout || error?.message || "").trim();
				// TS syntax errors are TS1000-TS1999 (grammar) and TS17000-TS17999 (JSX syntax)
				if (/error TS1(?:\d{3}|7\d{3}):/.test(output) || output.includes("SyntaxError")) {
					return {
						valid: false,
						status: "failed",
						error: `Syntax validation failed on ${path.basename(resolvedPath)}:\n${output}`,
					};
				}
				return {
					valid: true,
					status: "unavailable",
					error: output || "TypeScript compiler unavailable",
				};
			}
		} else {
			return {
				valid: true,
				status: "not run",
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
	if (!fs.existsSync(resolvedPath)) {
		return { valid: true, status: "clean" };
	}
	let content: string;
	try {
		content = fs.readFileSync(resolvedPath, "utf8");
	} catch (err: any) {
		return {
			valid: false,
			status: "inconclusive",
			error: `Syntax validation could not read ${path.basename(resolvedPath)}: ${err.message || String(err)}`,
		};
	}
	return checkSyntaxContent(resolvedPath, content);
}

// Checked by their own parser in validateSyntaxAtPath; tree-sitter only speeds up the TypeScript family.
const PARSER_CHECKED = new Set([".py", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"]);
const TYPESCRIPT_FAMILY = new Set([".ts", ".tsx", ".jsx", ".mts", ".cts"]);

// Error recovery can wrap a whole block in one error (e.g. a missing closing brace), so multi-line errors show their span.
function formatTreeSitterErrors(errors: Array<{ line: number; column: number; endLine: number; missing?: string; text?: string }>): string {
	const shown = errors.slice(0, 3).map((e) => {
		if (e.missing !== undefined) return `[${e.line}:${e.column}] missing "${e.missing}"`;
		return e.endLine > e.line
			? `[${e.line}:${e.column}] cannot parse lines ${e.line}-${e.endLine}, starting "${e.text}"`
			: `[${e.line}:${e.column}] unexpected "${e.text}"`;
	});
	return `tree-sitter found a syntax error: ${shown.join("; ")}${errors.length > 3 ? `; +${errors.length - 3} more` : ""}`;
}

/**
 * Validate candidate content without changing the target file. Pass the file's current content as `original` so that
 * tree-sitter can judge only what the edit changed (rules measured in .research/syntax-validation/):
 * - TypeScript family: clean when tree-sitter finds no error in the candidate or the original; otherwise tsc decides,
 *   because the grammar lags the language (e.g. `interface I<out T>`).
 * - Languages with a grammar but no parser here (Rust, Go, C/C++, Java, C#, Ruby, PHP, Bash): tree-sitter errors are
 *   reported only when the original parsed without errors; otherwise the check is not run.
 * - JavaScript, Python, JSON: always their own parser (tree-sitter misses JS early errors and Python indentation).
 * Call TreeSitterEngine.loadLanguages for the extension first; without a loaded grammar the parsers decide alone.
 */
export function checkSyntaxContent(
	filePath: string,
	content: string,
	original?: string,
): VerificationResult {
	const resolvedPath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	const ext = path.extname(resolvedPath).toLowerCase();
	if (TYPESCRIPT_FAMILY.has(ext) || !PARSER_CHECKED.has(ext)) {
		const engine = TreeSitterEngine.getInstance();
		const errors = engine.findSyntaxErrors(ext, content);
		const originalErrors = original === undefined ? undefined : engine.findSyntaxErrors(ext, original);
		if (!TYPESCRIPT_FAMILY.has(ext)) {
			if (!errors || !originalErrors || originalErrors.length > 0) return { valid: true, status: "not run" };
			return errors.length === 0
				? { valid: true, status: "clean" }
				: { valid: false, status: "failed", error: formatTreeSitterErrors(errors) };
		}
		if (errors?.length === 0 && !originalErrors?.length) return { valid: true, status: "clean" };
	}

	// `node --check` passes ES-module syntax errors in a .js file whose package.json sets no "type" (Node 24), so a
	// .js candidate is checked as .mjs and .cjs: valid when either parses, as Node itself decides at run time.
	const extensions = ext === ".js"
		? (/^\s*(import|export)\b/m.test(content) ? [".mjs", ".cjs"] : [".cjs", ".mjs"])
		: [path.extname(resolvedPath) || ".tmp"];
	let result: VerificationResult | undefined;
	for (const extension of extensions) {
		const res = validateCandidate(content, extension);
		if (res.valid) return res;
		result ??= res;
	}
	return result!;
}

/** Run the file-oriented validators on a temporary copy, so the target is never touched. */
function validateCandidate(content: string, extension: string): VerificationResult {
	let tempDir: string | undefined;

	try {
		// Outside the project, so file watchers never see it; the validators do not depend on the location
		// (tsc ignores tsconfig, and .js is checked with an explicit module type).
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), ".pi-agent-kernel-validate-"));
		const candidatePath = path.join(tempDir, `candidate${extension}`);
		fs.writeFileSync(candidatePath, content, "utf8");
		const res = validateSyntaxAtPath(candidatePath);
		if (!res.valid && res.error) {
			// Clean up leaked temporary directory and candidate filenames
			let cleanErr = res.error
				.replace(new RegExp(`.*\\.pi-agent-kernel-validate-[^/\\\\]+[\\/\\\\]candidate\\.[a-zA-Z0-9]+:?`, "g"), "")
				.replace(/Syntax validation failed on candidate\.[a-zA-Z0-9]+:?\s*/g, "")
				.trim();

			// Normalize "(line,col): error TSXXXX:" -> "[line:col] TSXXXX:"
			cleanErr = cleanErr.replace(
				/\(?(\d+)[,:]\s*(\d+)\)?:\s*(?:error\s+)?([A-Za-z0-9_]+:)?/g,
				(_, line, col, code) => `[${line}:${col}] ${code || ""}`,
			).trim();

			return {
				...res,
				error: cleanErr || res.error,
			};
		}
		return res;
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
