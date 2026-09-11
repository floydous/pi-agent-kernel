import * as fs from "node:fs";
import * as path from "node:path";
import { applySurgicalPatch, preflightSurgicalPatchBlock } from "../../src/editing/patch";
import { healMissingDelimitersWithAst, healJsonContent } from "../../src/editing/auto_heal";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testNextGenEditing(): Promise<void> {
	console.log("\n=== Next-Gen Editing & Auto-Healing Test Suite ===");
	const ws = createTestWorkspace("nextgen_edit_");
	try {
		// 1. Test Line Hint Disambiguation
		console.log("\n[1. Verifying Line-Hint Disambiguation]");
		const dupCode = [
			"export function foo() {",
			"  const val = 1;",
			"  return val;",
			"}",
			"",
			"export function bar() {",
			"  const val = 2;",
			"  return val;",
			"}",
			"",
			"export function baz() {",
			"  const val = 3;",
			"  return val;",
			"}",
		].join("\n");
		const testTs = path.join(ws.tempDir, "dup.ts");
		fs.writeFileSync(testTs, dupCode, "utf8");

		// Without hint -> ambiguous
		const preAmbiguous = preflightSurgicalPatchBlock(testTs, "  return val;");
		assertPass("Ambiguous target detected without hint", !preAmbiguous.success && !!preAmbiguous.isAmbiguous);

		// With line hint -> uniquely targets the middle block (bar at ~line 8)
		const preWithHint = preflightSurgicalPatchBlock(testTs, "  return val;", { lineHint: 8 });
		assertPass("Line hint successfully resolved target block", preWithHint.success && preWithHint.targetRange?.startLine === 8);

		const patchWithHint = applySurgicalPatch(testTs, "  return val;", "  return val * 10;", { lineHint: 8 });
		assertPass("Patch applied successfully using line hint", patchWithHint.success);
		const updatedContent = fs.readFileSync(testTs, "utf8");
		assertPass("Targeted block was updated correctly", updatedContent.includes("return val * 10;"));
		assertPass("Other duplicate blocks were untouched", updatedContent.startsWith("export function foo() {\n  const val = 1;\n  return val;"));

		// 2. Test Truncated Brackets Auto-Healing in TypeScript
		console.log("\n[2. Verifying Code Delimiter Auto-Healing in TS]");
		const originalFunc = [
			"export function calculateTotal(items: number[]): number {",
			"  let sum = 0;",
			"  for (const n of items) {",
			"    sum += n;",
			"  }",
			"  return sum;",
			"}",
		].join("\n");
		const calcTs = path.join(ws.tempDir, "calc.ts");
		fs.writeFileSync(calcTs, originalFunc, "utf8");

		// Replacement that truncates closing brace of the for loop and the function
		const truncatedReplace = [
			"export function calculateTotal(items: number[]): number {",
			"  let sum = 0;",
			"  for (const n of items) {",
			"    if (n > 0) sum += n;",
		].join("\n");

		const healedPatch = applySurgicalPatch(calcTs, originalFunc, truncatedReplace);
		assertPass("Auto-healing succeeded for truncated delimiters", healedPatch.success, { error: healedPatch.error });
		assertPass("Auto-healing strategy reported", healedPatch.strategy.includes("auto-healed syntax"));
		const healedTsContent = fs.readFileSync(calcTs, "utf8");
		assertPass("Repaired file is valid and complete", healedTsContent.includes("if (n > 0) sum += n;"));

		// 3. Test JSON Delimiter Auto-Healing
		console.log("\n[3. Verifying JSON Delimiter Auto-Healing]");
		const jsonFile = path.join(ws.tempDir, "data.json");
		fs.writeFileSync(jsonFile, '{\n  "version": "1.0.0"\n}\n', "utf8");

		const brokenJson = '{\n  "version": "2.0.0",\n  "features": ["a", "b"';
		const jsonHealed = healJsonContent(brokenJson);
		assertPass("JSON healer closed open array and object", !!jsonHealed && JSON.parse(jsonHealed).features.length === 2);

		const jsonPatch = applySurgicalPatch(jsonFile, '{\n  "version": "1.0.0"\n}\n', brokenJson);
		assertPass("JSON patch auto-healed seamlessly", jsonPatch.success);
		assertPass("JSON file on disk is valid JSON", typeof JSON.parse(fs.readFileSync(jsonFile, "utf8")) === "object");

		// 4. Test Delimiter Auto-Healing with Tree-sitter AST directly
		console.log("\n[4. Verifying Tree-sitter AST Delimiter Insertion]");
		const brokenSnippet = "export function test() {\n  const x = 1;\n  if (x > 0) {\n    return x;\n";
		const astResult = await healMissingDelimitersWithAst("sample.ts", brokenSnippet);
		assertPass("Tree-sitter AST detected missing delimiters", astResult.healed);
		assertPass("Applied fixes reported missing closing braces", astResult.appliedFixes.length > 0);

		logPass("Next-gen editing, line hinting, and delimiter auto-healing verified!");
	} finally {
		ws.cleanup();
	}
}

export async function run(): Promise<void> {
	await testNextGenEditing();
}

if (require.main === module) {
	testNextGenEditing().catch((err) => {
		console.error("Test failed:", err);
		process.exit(1);
	});
}
