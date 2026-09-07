import assert from "node:assert";
import type { AstQueryResult } from "../../src/retrieval/ast_search";
import { formatAstSearchResults } from "../../src/tools/ast_search_formatter";
import { logPass } from "../_setup";

export function testAliasAndEdgeCases(): void {
	// Alias with explicit aliasedFrom
	const aliasResult: AstQueryResult[] = [
		{
			filePath: "src/net/client.ts",
			name: "WebSocketClient",
			kind: "class",
			line: 12,
			endLine: 40,
			signature: "class client",
			aliasedFrom: { originalName: "client", module: "ws" },
		},
	];
	const outAlias = formatAstSearchResults(aliasResult, false);
	assert.ok(outAlias.includes("WebSocketClient [alias of client]"));

	// Normal typed declarations MUST NOT be misclassified as aliases
	const javaVoid: AstQueryResult[] = [
		{
			filePath: "src/Server.java",
			name: "run",
			kind: "method",
			line: 10,
			endLine: 15,
			signature: "public void run()",
		},
	];
	const outJava = formatAstSearchResults(javaVoid, false);
	assert.ok(!outJava.includes("[alias of"));
	assert.ok(outJava.includes("[method] 10-15 void run()"));

	// TS accessors must not be misclassified as aliases
	const tsAccessor: AstQueryResult[] = [
		{
			filePath: "src/prop.ts",
			name: "value",
			kind: "method",
			line: 5,
			endLine: 7,
			signature: "get value(): string",
		},
	];
	const outAccessor = formatAstSearchResults(tsAccessor, false);
	assert.ok(!outAccessor.includes("[alias of"));
	assert.ok(outAccessor.includes("[method] 5-7 value(): string"));

	// Duplicate symbol names in one kind group
	const dupNames: AstQueryResult[] = [
		{
			filePath: "src/overload.ts",
			name: "processItem",
			kind: "function",
			line: 10,
			endLine: 12,
			signature: "function processItem(id: number): void",
		},
		{
			filePath: "src/overload.ts",
			name: "processItem",
			kind: "function",
			line: 14,
			endLine: 18,
			signature: "function processItem(items: string[]): void",
		},
	];
	const outDup = formatAstSearchResults(dupNames, false);
	assert.ok(outDup.includes("- 10-12 processItem(id: number): void"));
	assert.ok(outDup.includes("- 14-18 processItem(items: string[]): void"));

	// Empty kind fallback
	const emptyKind: AstQueryResult[] = [
		{
			filePath: "src/unknown_kind.ts",
			name: "anonSymbol",
			kind: "" as any,
			line: 1,
			endLine: 1,
			signature: "anonSymbol",
		},
	];
	const outEmptyKind = formatAstSearchResults(emptyKind, false);
	assert.ok(outEmptyKind.includes("[symbol] 1 anonSymbol"));

	// Missing endLine -> single-line format
	const singleLineNoEnd: AstQueryResult[] = [
		{
			filePath: "src/consts.ts",
			name: "MAX_SIZE",
			kind: "constant",
			line: 42,
			signature: "const MAX_SIZE = 1024",
		},
	];
	const outSingleLineNoEnd = formatAstSearchResults(singleLineNoEnd, false);
	assert.ok(outSingleLineNoEnd.includes("[constant] 42 const MAX_SIZE = 1024"));

	// Windows backslash path normalization
	const winPath: AstQueryResult[] = [
		{
			filePath: "C:\\projects\\app\\src\\nested\\module.ts",
			name: "ModuleClass",
			kind: "class",
			line: 1,
			endLine: 10,
			signature: "class ModuleClass",
		},
	];
	const outWinPath = formatAstSearchResults(winPath, false);
	assert.ok(outWinPath.startsWith("C:/projects/app/src/nested/module.ts"));

	// Empty results produces empty string
	assert.strictEqual(formatAstSearchResults([], false), "");
	assert.strictEqual(formatAstSearchResults(null as any, false), "");

	logPass("Section 38: Alias metadata, edge cases, and path normalization verified!");
}
