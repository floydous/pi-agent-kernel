import * as fs from "node:fs";
import * as path from "node:path";
import { applyMultiBlockPatch } from "../../src/editing/patch";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testMultiBlockLineHintDisambiguation(): void {
	const ws = createTestWorkspace("multi_disambig_");
	try {
		const targetPath = path.join(ws.tempDir, "service.ts");
		const fileContent = [
			"// Section 1: Number Handler",
			"export function handleNumber(bag: any, min: number, max: number) {",
			"  bag.format = 'number';",
			"  bag.minimum = min;",
			"  bag.maximum = max;",
			"}",
			"",
			"// Section 2: Filler Lines to separate handlers",
			"export function helperOne() { return 1; }",
			"export function helperTwo() { return 2; }",
			"export function helperThree() { return 3; }",
			"",
			"// Section 3: BigInt Handler",
			"export function handleBigInt(bag: any, min: bigint, max: bigint) {",
			"  bag.format = 'bigint';",
			"  bag.minimum = min;",
			"  bag.maximum = max;",
			"}",
		].join("\n");

		fs.writeFileSync(targetPath, fileContent, "utf8");

		// Identical search block in both handlers
		const dupSearch = "  bag.minimum = min;\n  bag.maximum = max;";

		// 1. Without line_hint, preflight should reject due to ambiguous identical matches
		const ambiguousRes = applyMultiBlockPatch(targetPath, [
			{ search: dupSearch, replace: "  // replaced number" },
			{ search: dupSearch, replace: "  // replaced bigint" },
		]);
		assertPass("Ambiguous identical search blocks rejected without line hint", !ambiguousRes.success, {
			ambiguousRes,
		});

		// 2. With snake_case line_hint (as emitted by LLMs per tool schema)
		const snakeCaseRes = applyMultiBlockPatch(targetPath, [
			{
				search: dupSearch,
				replace: "  // replaced number (snake)",
				line_hint: 4,
			},
			{
				search: dupSearch,
				replace: "  // replaced bigint (snake)",
				line_hint: 15,
			},
		]);
		assertPass("Multi-block patch succeeds with snake_case line_hint", snakeCaseRes.success, {
			snakeCaseRes,
		});

		let updated = fs.readFileSync(targetPath, "utf8");
		assertPass("Number handler was updated at line 4", updated.includes("// replaced number (snake)"));
		assertPass("BigInt handler was updated at line 15", updated.includes("// replaced bigint (snake)"));

		// Reset file for camelCase check and line delta shift test
		fs.writeFileSync(targetPath, fileContent, "utf8");

		// 3. With camelCase lineHint AND line count delta (block 1 adds 3 new lines)
		const camelCaseRes = applyMultiBlockPatch(targetPath, [
			{
				search: dupSearch,
				replace: "  // line 1\n  // line 2\n  // line 3\n  // replaced number (camel)",
				lineHint: 4,
			},
			{
				search: dupSearch,
				replace: "  // replaced bigint (camel)",
				lineHint: 15,
			},
		]);
		assertPass("Multi-block patch succeeds with line shift and camelCase lineHint", camelCaseRes.success, {
			camelCaseRes,
		});

		updated = fs.readFileSync(targetPath, "utf8");
		assertPass("Number handler was updated with added lines", updated.includes("// replaced number (camel)"));
		assertPass("BigInt handler was correctly located despite line shift", updated.includes("// replaced bigint (camel)"));

		logPass("Multi-block line_hint disambiguation and line delta handling passed!");
	} finally {
		ws.cleanup();
	}
}
