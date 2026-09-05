import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { extractFileTags, SymbolDef } from "./repomap";

export interface CodeChunk {
	id: string;              // e.g. "src/auth.ts:45-90#verifyToken"
	filePath: string;        // Relative path
	absolutePath: string;
	startLine: number;
	endLine: number;
	symbolName: string;
	kind: string;            // "function" | "class" | "method" | "interface" | "type" | "block"
	signature: string;
	breadcrumb: string;      // e.g. "// [File: src/auth.ts] > [Class: AuthManager] > [Function: verifyToken]"
	content: string;         // The full code block text
	textForEmbedding: string;// Search-optimized representation
	hash: string;            // SHA-256 hash of content
}

const SUPPORTED_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".rb", ".php", ".swift", ".sh", ".bash", ".sql", ".md"
]);

const IGNORED_DIRS = new Set([
	".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "coverage", ".pi", ".hermes", ".next", ".turbo", ".cache", "target", "vendor"
]);

/**
 * Compute SHA-256 hash of a string.
 */
export function computeHash(content: string): string {
	return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * Chunk a single source file into logical AST-bounded chunks.
 */
export function chunkFile(rootDir: string, filePath: string, content?: string): CodeChunk[] {
	const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
	const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");

	let fileContent = content;
	if (fileContent === undefined) {
		try {
			fileContent = fs.readFileSync(absPath, "utf-8");
		} catch {
			return [];
		}
	}

	const lines = fileContent.split("\n");
	if (lines.length === 0) return [];

	const ext = path.extname(absPath).toLowerCase();
	const chunks: CodeChunk[] = [];

	// 1. Extract AST symbols using extractFileTags
	const tags = extractFileTags(absPath, fileContent);
	const defs = tags.definitions.sort((a, b) => a.line - b.line);

	// If file has no AST definitions or is small (< 40 lines), chunk as single whole file
	if (defs.length === 0 || lines.length <= 40) {
		const wholeContent = lines.join("\n");
		const breadcrumb = `// [File: ${relPath}]`;
		const hash = computeHash(wholeContent);
		chunks.push({
			id: `${relPath}:1-${lines.length}`,
			filePath: relPath,
			absolutePath: absPath,
			startLine: 1,
			endLine: lines.length,
			symbolName: path.basename(relPath),
			kind: "file",
			signature: `File: ${relPath}`,
			breadcrumb,
			content: wholeContent,
			textForEmbedding: `${breadcrumb}\n${wholeContent.slice(0, 1500)}`,
			hash,
		});
		return chunks;
	}

	// 2. Map symbol spans using delimiter & indentation boundaries
	interface SymbolSpan {
		def: SymbolDef;
		startLine: number;
		endLine: number;
		parentClass?: string;
	}

	const spans: SymbolSpan[] = [];
	let currentClass: string | undefined = undefined;
	let currentClassEndLine = -1;

	for (let i = 0; i < defs.length; i++) {
		const def = defs[i];
		const startIdx = Math.max(0, def.line - 1);
		let endIdx = lines.length - 1;

		if (def.line > currentClassEndLine) {
			currentClass = undefined;
		}

		if (def.kind === "class") {
			currentClass = def.name;
		}

		if (def.endLine && def.endLine >= def.line) {
			// Exact AST node boundaries from Tree-sitter
			endIdx = Math.min(lines.length - 1, def.endLine - 1);
		} else if (ext === ".py") {
			// Python scope
			const defLine = lines[startIdx];
			const matchIndent = defLine.match(/^(\s*)/);
			const baseIndent = matchIndent ? matchIndent[1].length : 0;

			for (let j = startIdx + 1; j < lines.length; j++) {
				const line = lines[j];
				if (!line.trim() || line.trim().startsWith("#")) continue;
				const indent = line.match(/^(\s*)/)?.[1].length || 0;
				if (indent <= baseIndent) {
					endIdx = j - 1;
					break;
				}
				endIdx = j;
			}
		} else {
			// Brace based scope (fallback)
			let braceCount = 0;
			let foundOpenBrace = false;

			for (let j = startIdx; j < lines.length; j++) {
				const line = lines[j];
				for (const ch of line) {
					if (ch === "{") {
						braceCount++;
						foundOpenBrace = true;
					} else if (ch === "}") {
						braceCount--;
					}
				}
				if (foundOpenBrace && braceCount <= 0) {
					endIdx = j;
					break;
				}
			}
		}

		// Bound endLine to before next top-level def if necessary
		if (i + 1 < defs.length && endIdx >= defs[i + 1].line - 1 && def.kind !== "class") {
			endIdx = Math.min(endIdx, defs[i + 1].line - 2);
		}

		endIdx = Math.max(startIdx, Math.min(lines.length - 1, endIdx));

		if (def.kind === "class") {
			currentClassEndLine = endIdx + 1;
		}

		spans.push({
			def,
			startLine: startIdx + 1,
			endLine: endIdx + 1,
			parentClass: def.kind !== "class" && def.line <= currentClassEndLine ? currentClass : undefined,
		});
	}

	// 3. Construct CodeChunk objects from spans
	for (const span of spans) {
		const startIdx = span.startLine - 1;
		const endIdx = span.endLine - 1;
		const chunkLines = lines.slice(startIdx, endIdx + 1);
		const chunkContent = chunkLines.join("\n");

		if (!chunkContent.trim()) continue;

		let breadcrumb = `// [File: ${relPath}]`;
		if (span.parentClass) {
			breadcrumb += ` > [Class: ${span.parentClass}]`;
		}
		breadcrumb += ` > [${span.def.kind.toUpperCase()}: ${span.def.name}]`;

		const textForEmbedding = `${breadcrumb}\nSignature: ${span.def.signature}\n\n${chunkContent.slice(0, 1500)}`;
		const hash = computeHash(chunkContent);

		chunks.push({
			id: `${relPath}:${span.startLine}-${span.endLine}#${span.def.name}`,
			filePath: relPath,
			absolutePath: absPath,
			startLine: span.startLine,
			endLine: span.endLine,
			symbolName: span.def.name,
			kind: span.def.kind,
			signature: span.def.signature,
			breadcrumb,
			content: chunkContent,
			textForEmbedding,
			hash,
		});
	}

	return chunks;
}

/**
 * Find supported source files in a workspace using the same traversal policy as
 * chunkWorkspace. The search index uses this to check live file freshness
 * without reparsing unchanged files.
 */
export function findChunkableFiles(rootDir: string, maxFiles = 500): string[] {
	const files: string[] = [];

	function scan(dir: string) {
		if (files.length >= maxFiles) return;
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
					files.push(fullPath);
					if (files.length >= maxFiles) return;
				}
			}
		}
	}

	scan(rootDir);
	return files;
}

/**
 * Scan workspace and chunk all supported source files.
 */
export function chunkWorkspace(rootDir: string, maxFiles = 500): { chunks: CodeChunk[]; fileCount: number } {
	const files = findChunkableFiles(rootDir, maxFiles);
	const chunks: CodeChunk[] = [];
	for (const filePath of files) {
		chunks.push(...chunkFile(rootDir, filePath));
	}
	return { chunks, fileCount: files.length };
}
