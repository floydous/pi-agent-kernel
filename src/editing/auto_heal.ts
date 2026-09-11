/**
 * Delimiter auto-healer for code and JSON.
 *
 * Catches the common agent failure mode where an edit truncates or forgets
 * closing delimiters () [] {} in replacement blocks.
 */

import { TreeSitterEngine } from "../retrieval/tree_sitter_engine";

export interface HealingResult {
	healed: boolean;
	code: string;
	appliedFixes: string[];
	reason?: string;
}

/**
 * Calculates unclosed opening delimiters in a snippet of code,
 * properly respecting string literals ('', "", ``), escapes, and comments (// and /* *\/).
 */
export function getUnclosedDelimiters(text: string): string[] {
	const stack: string[] = [];
	let inStr: string | null = null;
	let esc = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inLineComment) {
			if (c === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (c === "*" && i + 1 < text.length && text[i + 1] === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inStr) {
			if (esc) {
				esc = false;
			} else if (c === "\\") {
				esc = true;
			} else if (c === inStr) {
				inStr = null;
			}
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "/" && i + 1 < text.length) {
			if (text[i + 1] === "/") {
				inLineComment = true;
				i++;
				continue;
			} else if (text[i + 1] === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
		}
		if (c === "{" || c === "(" || c === "[") {
			stack.push(c);
		} else if (c === "}" || c === ")" || c === "]") {
			const match = stack[stack.length - 1];
			if (
				(match === "{" && c === "}") ||
				(match === "(" && c === ")") ||
				(match === "[" && c === "]")
			) {
				stack.pop();
			}
		}
	}

	const map: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
	return stack.reverse().map((ch) => map[ch]);
}

/**
 * Heals truncated JSON by stripping trailing commas and closing open braces/brackets.
 */
export function healJsonContent(jsonStr: string): string | null {
	try {
		JSON.parse(jsonStr);
		return jsonStr;
	} catch {
		// continue to repair
	}

	const stack: string[] = [];
	let inStr = false;
	let esc = false;
	for (let i = 0; i < jsonStr.length; i++) {
		const c = jsonStr[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{" || c === "[") stack.push(c);
		else if (c === "}" || c === "]") {
			const top = stack[stack.length - 1];
			if ((top === "{" && c === "}") || (top === "[" && c === "]")) stack.pop();
		}
	}

	if (stack.length === 0) return null;
	const closers: Record<string, string> = { "{": "}", "[": "]" };
	let candidate = jsonStr.trimEnd();
	if (candidate.endsWith(",")) candidate = candidate.slice(0, -1);
	for (let i = stack.length - 1; i >= 0; i--) {
		candidate += "\n" + closers[stack[i]];
	}
	try {
		JSON.parse(candidate);
		return candidate;
	} catch {
		return null;
	}
}

/**
 * Attempts to heal missing closing delimiters in a patched file using Tree-sitter.
 */
export async function healMissingDelimitersWithAst(
	filePath: string,
	code: string,
): Promise<HealingResult> {
	const ext = "." + filePath.split(".").pop();
	const engine = TreeSitterEngine.getInstance();
	await engine.init();
	await engine.loadLanguages([ext]);
	const parser = engine.getParser(ext);

	if (!parser) {
		return {
			healed: false,
			code,
			appliedFixes: [],
			reason: "No parser available for language",
		};
	}

	const initialTree = parser.parse(code);
	if (!initialTree.rootNode.hasError) {
		return { healed: true, code, appliedFixes: [], reason: "Code already valid" };
	}

	const missingNodes: any[] = [];
	const errorNodes: any[] = [];

	function walk(node: any) {
		if (node.isMissing) {
			missingNodes.push({
				type: node.type,
				startIndex: node.startIndex,
				endIndex: node.endIndex,
				startPosition: node.startPosition,
				endPosition: node.endPosition,
			});
		}
		if (node.isError) {
			errorNodes.push(node);
		}
		for (let i = 0; i < node.childCount; i++) {
			walk(node.child(i));
		}
	}
	walk(initialTree.rootNode);

	// If there are genuine syntax error nodes (not just missing tokens), do NOT blindly heal
	if (errorNodes.length > 0 || missingNodes.length === 0) {
		return {
			healed: false,
			code,
			appliedFixes: [],
			reason: `Unrecoverable syntax errors (${errorNodes.length} error nodes, ${missingNodes.length} missing nodes)`,
		};
	}

	const allowedDelimiters = new Set(["}", ")", "]", ";"]);
	const invalidMissing = missingNodes.filter((n) => !allowedDelimiters.has(n.type));
	if (invalidMissing.length > 0) {
		return {
			healed: false,
			code,
			appliedFixes: [],
			reason: `Non-delimiter tokens missing: ${invalidMissing.map((n) => n.type).join(", ")}`,
		};
	}

	// Sort missing nodes descending by start index to preserve positions during insertion
	const sorted = [...missingNodes].sort((a, b) => b.startIndex - a.startIndex);
	let repairedCode = code;
	const fixes: string[] = [];

	for (const node of sorted) {
		const insertPos = Math.min(node.startIndex, repairedCode.length);
		const token = node.type;
		const toInsert =
			token === "}" && !repairedCode.slice(0, insertPos).endsWith("\n")
				? "\n" + token
				: token;

		repairedCode =
			repairedCode.slice(0, insertPos) + toInsert + repairedCode.slice(insertPos);
		fixes.push(`Inserted '${token}' at line ${node.startPosition.row + 1}`);
	}

	const verifyTree = parser.parse(repairedCode);
	if (!verifyTree.rootNode.hasError) {
		return {
			healed: true,
			code: repairedCode,
			appliedFixes: fixes,
		};
	}

	return {
		healed: false,
		code,
		appliedFixes: [],
		reason: "Syntax still invalid after delimiter insertion",
	};
}
