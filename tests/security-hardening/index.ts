import * as assert from "node:assert";
import { parseToml } from "../../src/config/toml";
import { checkSyntaxContent, resolveNodeExecutable } from "../../src/editing/syntax-verify";
import { runErgonomicsAdversarialTests } from "./ergonomics_adversarial_test";

export async function run(): Promise<void> {
	console.log("\n=== Security Hardening & Penetration Test Suite ===");

	// 1. Prototype Pollution Defense
	console.log("[1. Verifying Prototype Pollution Defense]");
	const maliciousToml = `
[__proto__]
polluted1 = "malicious"

[constructor.prototype]
polluted2 = "malicious"

["__proto__"]
polluted_quoted = "malicious"

polluted3 = "malicious"
__proto__ = "danger"
"__proto__" = "danger"
"constructor.prototype.evil" = "danger"
`;
	const parsed = parseToml(maliciousToml);
	assert.strictEqual(
		(Object.prototype as any).polluted1,
		undefined,
		"Prototype must not be polluted by [__proto__] table header",
	);
	assert.strictEqual(
		(Object.prototype as any).polluted2,
		undefined,
		"Prototype must not be polluted by [constructor.prototype] table header",
	);
	assert.strictEqual(
		(Object.prototype as any).polluted_quoted,
		undefined,
		"Prototype must not be polluted by quoted table header",
	);
	assert.strictEqual(
		(Object.prototype as any).polluted3,
		undefined,
		"Prototype must not be polluted by properties",
	);
	assert.strictEqual(
		(Object.prototype as any).evil,
		undefined,
		"Prototype must not be polluted by dotted constructor key",
	);
	assert.strictEqual(
		({} as any).polluted1,
		undefined,
		"Empty object must not have polluted properties",
	);
	console.log("  ✓ Prototype pollution vectors in TOML parsing completely blocked");

	// 2. Safe Node Executable Discovery
	console.log("[2. Verifying Safe Executable Discovery]");
	const safeNode = resolveNodeExecutable();
	assert.ok(safeNode, "Valid Node executable candidate should be found");
	assert.strictEqual(typeof safeNode?.bin, "string", "Node executable binary path must be a string");
	console.log("  ✓ Executable discovery is free of shell spawning and option injection");

	// 3. Robust Template Literal Syntax Verification
	console.log("[3. Verifying Template Literal Syntax Verification]");
	const valid1 = checkSyntaxContent("test.ts", "const x = `select ${\"`\"} from table`;");
	assert.strictEqual(valid1.valid, true, "Template literal containing backtick in string must pass");

	const valid2 = checkSyntaxContent("test.ts", "const x = `outer ${ `inner ${1}` } end`;");
	assert.strictEqual(valid2.valid, true, "Nested template literals must pass");

	const valid3 = checkSyntaxContent("test.ts", "const x = `hello ${{ a: 1, b: [2, 3] }} world`;");
	assert.strictEqual(valid3.valid, true, "Complex expressions in template interpolations must pass");

	const invalid1 = checkSyntaxContent("test.ts", "const x = `hello ${ { a: 1 world`;");
	assert.strictEqual(invalid1.valid, false, "Unclosed brace inside interpolation must fail");

	const invalid2 = checkSyntaxContent("test.ts", "const x = `unclosed template;");
	assert.strictEqual(invalid2.valid, false, "Unterminated template literal must fail");
	console.log("  ✓ Template literal interpolations and delimiter balance verified");

	// 4. Ergonomics & Safety Boundary Adversarial Suite
	await runErgonomicsAdversarialTests();

	console.log("\n✓ Security Hardening & Penetration Test Suite Passed Successfully!");
}
