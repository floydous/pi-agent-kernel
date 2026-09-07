import type { AstQueryResult } from "../retrieval/ast_search";

/**
 * Clean signature string by removing redundant declaration keywords and access modifiers,
 * while preserving semantic modifiers (async, static, readonly, unsafe, const, mut)
 * and full parameter/return types.
 */
export function cleanSignature(rawSignature: string | undefined, symbolName: string | undefined): string {
	const trimmedName = symbolName?.trim();
	if (!rawSignature || !rawSignature.trim()) {
		return trimmedName || "unknown";
	}

	// Normalize multiline signatures to a single line
	let sig = rawSignature.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

	// Iteratively peel redundant leading prefixes from the start of the signature
	let changed = true;
	while (changed) {
		const before = sig;

		// 1. Module / declaration wrappers
		sig = sig.replace(/^(export\s+|default\s+|declare\s+)/, "");

		// 2. Visibility modifiers (TypeScript, Java, PHP, C++, Rust)
		sig = sig.replace(/^(public\s+|private\s+|protected\s+)/, "");
		sig = sig.replace(/^pub(\s*\([^)]*\))?\s+/, "");

		// 3. Redundant kind keywords (when not preceded by async/static/unsafe)
		// e.g. "function foo()", "def foo()", "fn foo()", "func foo()", "class Foo"
		sig = sig.replace(/^(function\s*\*?|def\s+|fn\s+|func\s+|class\s+|interface\s+|type\s+|enum\s+|struct\s+|trait\s+)/, "");

		// 4. Strip redundant kind keywords that follow preserved semantic modifiers (async, static, unsafe)
		sig = sig.replace(/^((?:async|static|unsafe)\s+)(?:function\s*\*?|fn|def|func)\s+/, "$1");

		// 5. TypeScript/ES accessors (get/set)
		sig = sig.replace(/^(get\s+|set\s+)/, "");

		// 6. Abstract modifier
		sig = sig.replace(/^abstract\s+/, "");

		sig = sig.trim();
		changed = sig !== before;
	}

	return sig.trim() || trimmedName || "unknown";
}

/**
 * Format raw AST search results into a compact hierarchical layout:
 * - Each normalized file path appears once.
 * - Symbols are grouped by kind preserving incoming rank order.
 * - Singletons of a kind render inline: `[kind] range signature`
 * - Multiple items of a kind render with a header and `- range signature`
 * - Optional body preview indented with 4 spaces and truncation notice
 */
export function formatAstSearchResults(
	results: AstQueryResult[],
	includeBody = false,
): string {
	if (!results || results.length === 0) {
		return "";
	}

	// 1. Group by normalized relative filePath preserving first-seen file order
	const fileOrder: string[] = [];
	const byFile = new Map<string, Map<string, AstQueryResult[]>>();

	for (const r of results) {
		const normPath = r.filePath.replace(/\\/g, "/");
		let byKind = byFile.get(normPath);
		if (!byKind) {
			byKind = new Map<string, AstQueryResult[]>();
			byFile.set(normPath, byKind);
			fileOrder.push(normPath);
		}

		const kind = r.kind || "symbol";
		let items = byKind.get(kind);
		if (!items) {
			items = [];
			byKind.set(kind, items);
		}
		items.push(r);
	}

	// 2. Build sections
	const sections: string[] = [];

	for (const filePath of fileOrder) {
		const byKind = byFile.get(filePath)!;
		const fileLines: string[] = [filePath];

		for (const [kind, items] of byKind) {
			if (items.length === 1) {
				const r = items[0];
				const span = formatRange(r.line, r.endLine);
				const sig = formatSymbolSignature(r);
				fileLines.push(`[${kind}] ${span} ${sig}`);
				if (includeBody && (r.codeBlock !== undefined || r.bodyTruncated)) {
					fileLines.push(indentBody(r.codeBlock, r.bodyTruncated, r.visibleEndLine));
				}
			} else {
				fileLines.push(`[${kind}]`);
				for (const r of items) {
					const span = formatRange(r.line, r.endLine);
					const sig = formatSymbolSignature(r);
					fileLines.push(`- ${span} ${sig}`);
					if (includeBody && (r.codeBlock !== undefined || r.bodyTruncated)) {
						fileLines.push(indentBody(r.codeBlock, r.bodyTruncated, r.visibleEndLine));
					}
				}
			}
		}

		sections.push(fileLines.join("\n"));
	}

	return sections.join("\n\n");
}

function formatRange(startLine: number, endLine?: number): string {
	if (endLine !== undefined && endLine !== null && endLine > startLine) {
		return `${startLine}-${endLine}`;
	}
	return `${startLine}`;
}

function formatSymbolSignature(r: AstQueryResult): string {
	const name = r.name?.trim() || "unknown";
	let sig = cleanSignature(r.signature, r.name);

	if (r.aliasedFrom && r.aliasedFrom.originalName && r.aliasedFrom.originalName !== name) {
		const orig = r.aliasedFrom.originalName;
		if (sig === orig) {
			sig = name;
		} else if (sig.startsWith(orig + "(") || sig.startsWith(orig + "<") || sig.startsWith(orig + " ")) {
			sig = name + sig.slice(orig.length);
		}
		sig = `${sig} [alias of ${orig}]`;
	}

	return sig;
}

function indentBody(codeBlock?: string, bodyTruncated?: boolean, visibleEndLine?: number): string {
	const indentedLines: string[] = [];
	if (codeBlock && codeBlock.trim()) {
		for (const line of codeBlock.split("\n")) {
			indentedLines.push(`    ${line}`);
		}
	}
	if (bodyTruncated) {
		if (visibleEndLine !== undefined && visibleEndLine !== null) {
			indentedLines.push(`    [... body preview truncated at line ${visibleEndLine}]`);
		} else {
			indentedLines.push(`    [... body preview truncated]`);
		}
	}
	return indentedLines.join("\n");
}
