import assert from "node:assert";
import type { AstQueryResult } from "../../src/retrieval/ast_search";
import { formatAstSearchResults } from "../../src/tools/ast_search_formatter";
import { logPass } from "../_setup";

export function testBodyAndTruncation(): void {
	// 1. Singleton without body remains inline
	const singleNoBody: AstQueryResult[] = [
		{
			filePath: "src/singleton.ts",
			name: "SingleClass",
			kind: "class",
			line: 5,
			endLine: 20,
			signature: "class SingleClass",
		},
	];
	const outSingleNoBody = formatAstSearchResults(singleNoBody, false);
	assert.ok(outSingleNoBody.includes("[class] 5-20 SingleClass"));
	assert.strictEqual(outSingleNoBody.split("\n").length, 2);

	// 2. Singleton with body remains inline with 4-space indented body
	const singleWithBody: AstQueryResult[] = [
		{
			filePath: "src/singleton.ts",
			name: "SingleClass",
			kind: "class",
			line: 5,
			endLine: 8,
			signature: "class SingleClass",
			codeBlock: "class SingleClass {\n  constructor() {}\n}",
			bodyTruncated: false,
		},
	];
	const outSingleWithBody = formatAstSearchResults(singleWithBody, true);
	const expectedInlineWithBody = [
		"src/singleton.ts",
		"[class] 5-8 SingleClass",
		"    class SingleClass {",
		"      constructor() {}",
		"    }",
	].join("\n");
	assert.strictEqual(outSingleWithBody, expectedInlineWithBody);

	// 3. Multiple bodies remain attached to their symbols
	const multiWithBody: AstQueryResult[] = [
		{
			filePath: "src/utils.ts",
			name: "fnA",
			kind: "function",
			line: 1,
			endLine: 3,
			signature: "function fnA(): void",
			codeBlock: "function fnA(): void {\n  return;\n}",
			bodyTruncated: false,
		},
		{
			filePath: "src/utils.ts",
			name: "fnB",
			kind: "function",
			line: 10,
			endLine: 12,
			signature: "function fnB(): void",
			codeBlock: "function fnB(): void {\n  return;\n}",
			bodyTruncated: false,
		},
	];
	const outMultiWithBody = formatAstSearchResults(multiWithBody, true);
	assert.ok(outMultiWithBody.includes("[function]\n- 1-3 fnA(): void\n    function fnA(): void {"));

	// 4. Truncation marker with visibleEndLine
	const truncatedWithEnd: AstQueryResult[] = [
		{
			filePath: "src/big.ts",
			name: "bigFn",
			kind: "function",
			line: 1,
			endLine: 100,
			signature: "function bigFn(): void",
			codeBlock: "function bigFn() {\n  // line 2\n}",
			bodyTruncated: true,
			visibleEndLine: 25,
		},
	];
	const outTruncatedWithEnd = formatAstSearchResults(truncatedWithEnd, true);
	assert.ok(outTruncatedWithEnd.includes("    [... body preview truncated at line 25]"));

	// 5. Truncation marker without visibleEndLine
	const truncatedNoEnd: AstQueryResult[] = [
		{
			filePath: "src/big.ts",
			name: "bigFn",
			kind: "function",
			line: 1,
			endLine: 100,
			signature: "function bigFn(): void",
			codeBlock: "function bigFn() {\n  // line 2\n}",
			bodyTruncated: true,
		},
	];
	const outTruncatedNoEnd = formatAstSearchResults(truncatedNoEnd, true);
	assert.ok(outTruncatedNoEnd.includes("    [... body preview truncated]"));

	// 6. No marker for non-truncated
	assert.ok(!outSingleWithBody.includes("[... body preview truncated"));

	// 7. Empty codeBlock with bodyTruncated: true MUST emit marker
	const emptyTruncated: AstQueryResult[] = [
		{
			filePath: "src/empty.ts",
			name: "stubFn",
			kind: "function",
			line: 1,
			endLine: 50,
			signature: "function stubFn()",
			codeBlock: "",
			bodyTruncated: true,
			visibleEndLine: 1,
		},
	];
	const outEmptyTruncated = formatAstSearchResults(emptyTruncated, true);
	assert.ok(outEmptyTruncated.includes("    [... body preview truncated at line 1]"));

	logPass("Body preview, indentation, and truncation markers verified!");
}
