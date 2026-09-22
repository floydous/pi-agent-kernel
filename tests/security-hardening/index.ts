import * as assert from "node:assert";
import { parseToml } from "../../src/config/toml";
import { findExecutable } from "../../src/lsp/lsp_registry";
import { checkSyntaxContent } from "../../src/editing/syntax-verify";
import { formatDefinitions, formatReferences } from "../../src/lsp/lsp_formatter";
import { StdioLspClient } from "../../src/lsp/lsp_client";

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

	// 2. Safe Executable Discovery
	console.log("[2. Verifying Safe Executable Discovery]");
	const safeNode = findExecutable("node");
	assert.ok(safeNode, "Valid binary 'node' should be found");

	const injectionAttempt1 = findExecutable('node" & calc.exe & "');
	assert.strictEqual(injectionAttempt1, null, "Shell metacharacter lookup must safely return null");

	const injectionAttempt2 = findExecutable("--version");
	assert.strictEqual(injectionAttempt2, null, "Option injection lookup must safely return null");

	const nonexistent = findExecutable("definitely_nonexistent_binary_12345");
	assert.strictEqual(nonexistent, null, "Nonexistent binary must return null");
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

	// 4. Windows Display Path Normalization
	console.log("[4. Verifying Cross-Platform Path Normalization]");
	const dummyLoc = {
		uri: "file:///C:/project/src/index.ts",
		range: { start: { line: 10, character: 5 }, end: { line: 10, character: 15 } },
	};
	const formattedDef = formatDefinitions([dummyLoc], "C:\\project");
	assert.ok(
		formattedDef.includes("src/index.ts:11:6"),
		`Display path in definition must use forward slashes: ${formattedDef}`,
	);
	console.log("  ✓ Formatter consistently produces forward-slash display paths across platforms");

	// 5. LSP Framing Robustness
	console.log("[5. Verifying LSP Stdio Framing Defenses]");

	const createClient = () => {
		const client = new StdioLspClient("test", {
			command: "node",
			args: ["-e", "process.stdin.resume()"],
			cwd: process.cwd(),
			languageId: "typescript",
		});
		let count = 0;
		let last: any = null;
		(client as any).handleMessage = (msg: any) => {
			count++;
			last = msg;
		};
		return { client, getCount: () => count, getLast: () => last };
	};

	// 5a. Multibyte UTF-8 frame
	{
		const { client, getCount, getLast } = createClient();
		const multibyteContent = JSON.stringify({ message: "Hello 🚀 世界" });
		const utf8Bytes = Buffer.byteLength(multibyteContent, "utf8");
		const validFrame = Buffer.from(`Content-Length: ${utf8Bytes}\r\n\r\n${multibyteContent}`, "utf8");
		(client as any).onData(validFrame);
		assert.strictEqual(getCount(), 1, "Multibyte UTF-8 LSP frame must be parsed correctly");
		assert.strictEqual(getLast()?.message, "Hello 🚀 世界");
	}

	// 5b. Partial/malformed Content-Length with trailing characters (e.g. 12junk) must be rejected
	{
		const { client, getCount } = createClient();
		(client as any).onData(Buffer.from("Content-Length: 12junk\r\n\r\n{}"));
		assert.strictEqual(getCount(), 0, "Malformed Content-Length with trailing characters must be rejected");
	}

	// 5c. Oversized Content-Length must reset/drop buffer
	{
		const { client, getCount } = createClient();
		(client as any).onData(Buffer.from("Content-Length: 999999999\r\n\r\n{}"));
		assert.strictEqual(getCount(), 0, "Oversized frame must not be parsed");
	}

	// 5d. Negative Content-Length must be discarded
	{
		const { client, getCount } = createClient();
		(client as any).onData(Buffer.from("Content-Length: -50\r\n\r\n{}"));
		assert.strictEqual(getCount(), 0, "Negative length frame must be rejected");
	}

	// 5e. Fragmented frame split across two chunks
	{
		const { client, getCount, getLast } = createClient();
		const splitMsg = JSON.stringify({ test: "split" });
		const splitBytes = Buffer.byteLength(splitMsg, "utf8");
		const headerAndFirstPart = Buffer.concat([
			Buffer.from(`Content-Length: ${splitBytes}\r\n\r\n`, "utf8"),
			Buffer.from(splitMsg.slice(0, 6), "utf8"),
		]);
		const secondPart = Buffer.from(splitMsg.slice(6), "utf8");

		(client as any).onData(headerAndFirstPart);
		assert.strictEqual(getCount(), 0, "Incomplete frame should not trigger dispatch");
		(client as any).onData(secondPart);
		assert.strictEqual(getCount(), 1, "Completed fragmented frame must be dispatched");
		assert.strictEqual(getLast()?.test, "split");
	}

	// 5f. Multiple frames concatenated in a single chunk
	{
		const { client, getCount, getLast } = createClient();
		const multi1 = JSON.stringify({ seq: 1 });
		const multi2 = JSON.stringify({ seq: 2 });
		const multiChunk = Buffer.from(
			`Content-Length: ${Buffer.byteLength(multi1, "utf8")}\r\n\r\n${multi1}` +
			`Content-Length: ${Buffer.byteLength(multi2, "utf8")}\r\n\r\n${multi2}`,
			"utf8",
		);
		(client as any).onData(multiChunk);
		assert.strictEqual(getCount(), 2, "Multiple concatenated frames must both be dispatched");
		assert.strictEqual(getLast()?.seq, 2);
	}

	console.log("  ✓ LSP stdio framing resilient against malformed headers, fragmentation, and oversized payloads");
	console.log("\n✓ Security Hardening & Penetration Test Suite Passed Successfully!");
}
