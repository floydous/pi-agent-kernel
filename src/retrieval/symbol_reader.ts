import * as fs from "fs";
import * as path from "path";
import { extractFileTags, SymbolDef } from "./repomap";

export interface SymbolLocation {
	name: string;
	kind: string;
	signature: string;
	startLine: number;
	endLine: number;
	content: string;
	filePath: string;
}

/**
 * Extract exact start and end line range for a symbol in a file.
 */
export function extractSymbolContent(
	filePath: string,
	targetSymbol: string,
	options: { surroundingLines?: number } = {},
	fileContentOverride?: string,
): { found: boolean; symbols: SymbolLocation[]; error?: string } {
	const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

	if (!fs.existsSync(resolvedPath)) {
		return { found: false, symbols: [], error: `File not found: ${resolvedPath}` };
	}

	let fileContent: string;
	if (fileContentOverride !== undefined) {
		fileContent = fileContentOverride;
	} else {
		try {
			fileContent = fs.readFileSync(resolvedPath, "utf-8");
		} catch (e: any) {
			return { found: false, symbols: [], error: `Unable to read file: ${e.message}` };
		}
	}

	const lines = fileContent.split("\n");
	const tags = extractFileTags(resolvedPath, fileContent);
	const ext = path.extname(resolvedPath).toLowerCase();

	const matches: SymbolLocation[] = [];

	// Search matching definitions in tags
	const matchingDefs = tags.definitions.filter(
		(d) => d.name === targetSymbol || d.name.toLowerCase() === targetSymbol.toLowerCase()
	);

	if (matchingDefs.length === 0) {
		// Fallback: search for symbol with regex across all occurrences if tags missed it
		const escaped = targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`(?:def|class|function|async function|const|let|var|type|interface)\\s+${escaped}\\b`, "i");
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				matchingDefs.push({
					name: targetSymbol,
					kind: lines[i].includes("class") ? "class" : "function",
					signature: lines[i].trim(),
					line: i + 1,
				});
			}
		}
	}

	for (const def of matchingDefs) {
		const startIdx = def.line - 1;
		let endIdx = startIdx;

		// Include preceding docstrings/comments/decorators if present
		let actualStartIdx = startIdx;
		while (actualStartIdx > 0) {
			const prevLine = lines[actualStartIdx - 1].trim();
			if (prevLine.startsWith("#") || prevLine.startsWith("//") || prevLine.startsWith("*") || prevLine.startsWith("/*") || prevLine.startsWith("@")) {
				actualStartIdx--;
			} else {
				break;
			}
		}

		if (def.endLine && def.endLine >= def.line) {
			// Ground-truth AST range provided directly by Tree-sitter
			endIdx = Math.min(lines.length - 1, def.endLine - 1);
		} else if (ext === ".py") {
			// Python indentation based boundary detection
			const defLine = lines[startIdx];
			const matchIndent = defLine.match(/^(\s*)/);
			const baseIndent = matchIndent ? matchIndent[1].length : 0;

			// Handle multi-line Python signatures (e.g. def foo(\n arg: int\n) -> bool:)
			let headerEndIdx = startIdx;
			let parenCount = 0;
			for (let i = startIdx; i < lines.length; i++) {
				const line = lines[i];
				for (const ch of line) {
					if (ch === "(") parenCount++;
					else if (ch === ")") parenCount--;
				}
				if (parenCount <= 0 && line.trim().endsWith(":")) {
					headerEndIdx = i;
					break;
				}
			}

			let inDocstring = false;
			let docstringQuote = "";

			for (let i = headerEndIdx + 1; i < lines.length; i++) {
				const currentLine = lines[i];
				const trimmed = currentLine.trim();

				if (!trimmed) {
					endIdx = i;
					continue;
				}

				// Check docstrings
				if (!inDocstring) {
					if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
						docstringQuote = trimmed.slice(0, 3);
						if (trimmed.length === 3 || !trimmed.slice(3).includes(docstringQuote)) {
							inDocstring = true;
						}
					}
				} else {
					if (trimmed.includes(docstringQuote)) {
						inDocstring = false;
					}
					endIdx = i;
					continue;
				}

				if (inDocstring) {
					endIdx = i;
					continue;
				}

				if (trimmed.startsWith("#")) {
					endIdx = i;
					continue;
				}

				const currIndent = currentLine.match(/^(\s*)/)?.[1].length || 0;
				if (currIndent <= baseIndent) {
					break;
				}
				endIdx = i;
			}
		} else {
			// Brace-based languages (fallback if AST endLine is unavailable)
			let braceCount = 0;
			let foundOpenBrace = false;

			for (let i = startIdx; i < lines.length; i++) {
				const currentLine = lines[i];

				for (let charIdx = 0; charIdx < currentLine.length; charIdx++) {
					const char = currentLine[charIdx];
					if (char === "{") {
						braceCount++;
						foundOpenBrace = true;
					} else if (char === "}") {
						braceCount--;
					}
				}

				endIdx = i;
				if (foundOpenBrace && braceCount <= 0) {
					break;
				}
			}
		}

		// Apply surrounding context if requested (capped at 10 lines to prevent context bloat)
		const requestedExtra = options.surroundingLines || 0;
		const extra = Math.min(10, Math.max(0, requestedExtra));
		const finalStart = Math.max(0, actualStartIdx - extra);
		const finalEnd = Math.min(lines.length - 1, endIdx + extra);

		const rawContent = lines.slice(finalStart, finalEnd + 1).join("\n");

		matches.push({
			name: def.name,
			kind: def.kind,
			signature: def.signature,
			startLine: finalStart + 1,
			endLine: finalEnd + 1,
			content: rawContent,
			filePath: resolvedPath,
		});
	}

	// Deduplicate strictly overlapping companion symbols (e.g. interface + companion const at the same lines)
	// Only merge if one range actually contains or directly overlaps the other (not distinct separate functions)
	const deduped: SymbolLocation[] = [];
	for (const m of matches) {
		const existingIdx = deduped.findIndex(
			(d) =>
				d.name.toLowerCase() === m.name.toLowerCase() &&
				// Overlap condition: ranges must strictly intersect
				d.startLine <= m.endLine && m.startLine <= d.endLine,
		);
		if (existingIdx !== -1) {
			const ex = deduped[existingIdx];
			// Merge the overlapping range
			const mergedStart = Math.min(ex.startLine, m.startLine);
			const mergedEnd = Math.max(ex.endLine, m.endLine);
			deduped[existingIdx] = {
				name: ex.name,
				kind: ex.kind === "interface" || ex.kind === "type" ? m.kind : ex.kind,
				signature: ex.signature || m.signature,
				startLine: mergedStart,
				endLine: mergedEnd,
				content: lines.slice(mergedStart - 1, mergedEnd).join("\n"),
				filePath: ex.filePath,
			};
		} else {
			deduped.push(m);
		}
	}

	return {
		found: deduped.length > 0,
		symbols: deduped,
	};
}
