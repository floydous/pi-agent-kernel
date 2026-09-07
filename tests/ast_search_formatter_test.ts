import assert from "assert";
import type { AstQueryResult } from "../src/retrieval/ast_search";
// @ts-ignore - cleanSignature to be implemented
import { formatAstSearchResults, cleanSignature } from "../src/tools/ast_search_formatter";

function testBasicGroupingAndLayout() {
	const rawResults: AstQueryResult[] = [
		{
			filePath: "src\\routes\\proxy.rs",
			name: "catch_all",
			kind: "function",
			line: 27,
			endLine: 369,
			signature: "fn catch_all(req: Request) -> Response",
		},
		{
			filePath: "src/models/user.ts",
			name: "User",
			kind: "class",
			line: 10,
			endLine: 45,
			signature: "class User",
		},
		{
			filePath: "src\\routes\\proxy.rs",
			name: "json_error",
			kind: "function",
			line: 373,
			endLine: 384,
			signature: "fn json_error(msg: &str) -> Response",
		},
	];

	const output = formatAstSearchResults(rawResults, false);

	console.log("Output from testBasicGroupingAndLayout:\n" + output);

	// 1. Each normalized path appears exactly once
	const proxyMatches = output.match(/src\/routes\/proxy\.rs/g) || [];
	assert.strictEqual(proxyMatches.length, 1, "src/routes/proxy.rs should appear once");

	const userMatches = output.match(/src\/models\/user\.ts/g) || [];
	assert.strictEqual(userMatches.length, 1, "src/models/user.ts should appear once");

	// 2. Preserves incoming file order: proxy.rs first, user.ts second
	const proxyIdx = output.indexOf("src/routes/proxy.rs");
	const userIdx = output.indexOf("src/models/user.ts");
	assert.ok(proxyIdx !== -1 && userIdx !== -1 && proxyIdx < userIdx, "File order must be preserved");

	// 3. Repeated functions appear under one [function] heading with dashes
	assert.ok(output.includes("[function]\n- 27-369"), "Multi-symbol kind must have [kind] header and bulleted dash");
	assert.ok(output.includes("- 373-384"), "Second function must be bulleted under same header");

	// 4. Singleton class must be inline
	assert.ok(output.includes("[class] 10-45"), "Singleton kind must be inline [class] 10-45");

	console.log("✓ Task 2 testBasicGroupingAndLayout passed!");
}

function testSignatureCleaning() {
	// 1. TS method with public visibility
	assert.strictEqual(
		cleanSignature("public checkReadPrecondition(path: string): boolean", "checkReadPrecondition"),
		"checkReadPrecondition(path: string): boolean"
	);

	// 2. TS top-level function
	assert.strictEqual(
		cleanSignature("function normalizeUri(uri: string): string", "normalizeUri"),
		"normalizeUri(uri: string): string"
	);

	// 3. Rust async pub fn
	assert.strictEqual(
		cleanSignature("pub async fn dispatch_response(resp: Response) -> Result<()>", "dispatch_response"),
		"async dispatch_response(resp: Response) -> Result<()>"
	);

	// 4. Multiline Python signature with parameters and return type
	const pySig = `def process_transaction(
    self,
    user_id: str,
    amount: float
) -> bool:`;
	assert.strictEqual(
		cleanSignature(pySig, "process_transaction"),
		"process_transaction( self, user_id: str, amount: float ) -> bool:"
	);

	// 5. Empty signature fallback to name
	assert.strictEqual(cleanSignature("", "mySymbol"), "mySymbol");

	// 6. Empty signature and empty name fallback to unknown
	assert.strictEqual(cleanSignature("", ""), "unknown");

	// 7. Meaningful modifiers preserved: static, readonly, async, unsafe
	assert.strictEqual(
		cleanSignature("public static async compute(x: number): Promise<number>", "compute"),
		"static async compute(x: number): Promise<number>"
	);

	// 8. Rust unsafe fn keyword stripping
	assert.strictEqual(
		cleanSignature("pub unsafe fn raw_alloc(size: usize) -> *mut u8", "raw_alloc"),
		"unsafe raw_alloc(size: usize) -> *mut u8"
	);

	// 9. PHP / JS static function keyword stripping
	assert.strictEqual(
		cleanSignature("static function parse(input: string): Data", "parse"),
		"static parse(input: string): Data"
	);

	// 10. Java / C# typed declarations
	assert.strictEqual(
		cleanSignature("public void run()", "run"),
		"void run()"
	);
	assert.strictEqual(
		cleanSignature("private static void execute()", "execute"),
		"static void execute()"
	);

	// 11. TypeScript accessors
	assert.strictEqual(
		cleanSignature("get value(): string", "value"),
		"value(): string"
	);
	assert.strictEqual(
		cleanSignature("set value(v: string)", "value"),
		"value(v: string)"
	);

	// 12. Abstract classes and methods
	assert.strictEqual(
		cleanSignature("abstract class Shape", "Shape"),
		"Shape"
	);

	console.log("✓ Task 4 testSignatureCleaning passed!");
}

function testBodyAndTruncationFormatting() {
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
	assert.ok(outSingleNoBody.includes("[class] 5-20 SingleClass"), "Singleton without body must be inline");
	assert.strictEqual(outSingleNoBody.split("\n").length, 2, "Singleton without body should have 2 lines (path + inline def)");

	// 2. Singleton with body remains inline and has the body underneath with 4 spaces indent
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
	assert.strictEqual(outSingleWithBody, expectedInlineWithBody, "Singleton with body must be inline with indented body");

	// 3. Multiple symbols each retain their own body, correctly indented
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
	assert.ok(outMultiWithBody.includes("[function]\n- 1-3 fnA(): void\n    function fnA(): void {\n      return;\n    }\n- 10-12 fnB(): void\n    function fnB(): void {"));

	// 4. bodyTruncated emits a marker with visibleEndLine when available
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
	assert.ok(
		outTruncatedWithEnd.includes("    [... body preview truncated at line 25]"),
		"Truncated body with visibleEndLine must emit marker"
	);

	// 5. bodyTruncated emits marker without visibleEndLine if undefined
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
	assert.ok(
		outTruncatedNoEnd.includes("    [... body preview truncated]"),
		"Truncated body without visibleEndLine must emit fallback marker"
	);

	// 6. No marker emitted when bodyTruncated is false or undefined
	assert.ok(!outSingleWithBody.includes("[... body preview truncated"), "No truncation marker when not truncated");

	// 7. Empty codeBlock with bodyTruncated: true MUST emit truncation marker
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
	assert.ok(
		outEmptyTruncated.includes("    [... body preview truncated at line 1]"),
		"Empty preview with bodyTruncated: true must emit marker"
	);

	console.log("✓ Task 5 testBodyAndTruncationFormatting passed!");
}

function testAliasAndEdgeCases() {
	// 1. Alias result whose `name` differs from the source signature name with explicit aliasedFrom
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
	assert.ok(
		outAlias.includes("WebSocketClient [alias of client]"),
		"Primary name 'WebSocketClient' and alias provenance must be formatted"
	);

	// 1b. Normal typed declarations MUST NOT be misclassified as aliases:
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
	assert.ok(!outJava.includes("[alias of"), "public void run() must never be classified as an alias");
	assert.ok(outJava.includes("[method] 10-15 void run()"), "Should format clean signature with return type");

	// 1c. TS accessors (get/set) must not be misclassified as aliases:
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
	assert.ok(!outAccessor.includes("[alias of"), "get value() must never be classified as an alias");
	assert.ok(outAccessor.includes("[method] 5-7 value(): string"), "Should strip accessor keyword cleanly");

	// 2. Duplicate symbol names in one kind group
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

	// 3. Empty kind fallback
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
	assert.ok(outEmptyKind.includes("[symbol] 1 anonSymbol"), "Empty kind should fallback to [symbol]");

	// 4. Missing or equal endLine -> single-line format
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
	assert.ok(outSingleLineNoEnd.includes("[constant] 42 const MAX_SIZE = 1024"), "Missing endLine must output single line number");

	// 5. Windows backslash path normalization
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
	assert.ok(
		outWinPath.startsWith("C:/projects/app/src/nested/module.ts"),
		"Backslashes must be normalized to forward slashes"
	);

	// 6. Empty results produces empty string
	assert.strictEqual(formatAstSearchResults([], false), "");
	assert.strictEqual(formatAstSearchResults(null as any, false), "");

	console.log("✓ Task 6 testAliasAndEdgeCases passed!");
}

async function testToolIntegration() {
	// Import the actual tool registration and test through execution
	const { registerAstSearchTool } = await import("../src/tools/ast_search_tool");
	const { globalEpistemicGuard } = await import("../src/safety/epistemic_guard");

	let registeredTool: any = null;
	const fakePi: any = {
		registerTool: (tool: any) => {
			if (tool.name === "ast_search") {
				registeredTool = tool;
			}
		},
	};

	const fakeDeps: any = {
		getSessionId: () => "test-session-task8",
	};

	registerAstSearchTool(fakePi, fakeDeps);
	assert.ok(registeredTool, "ast_search tool must be registered");

	const ctx = { cwd: process.cwd() };

	// Instrument guard spy
	let guardCallCount = 0;
	const originalRecordFileSearched = globalEpistemicGuard.recordFileSearched.bind(globalEpistemicGuard);
	globalEpistemicGuard.recordFileSearched = (...args: any[]) => {
		guardCallCount++;
		return originalRecordFileSearched(...(args as [any, any, any, any]));
	};

	// 1. Search for a known function in the codebase
	const res = await registeredTool.execute(
		"call-ast-test-1",
		{ filePattern: "src/lsp/lsp_formatter.ts", kind: "function" },
		undefined,
		() => {},
		ctx
	);

	assert.ok(res.content && res.content[0], "Result must have content");
	const text = res.content[0].text;
	console.log("Integration test output preview:\n" + text.split("\n").slice(0, 6).join("\n"));

	// Grouping verification:
	assert.ok(text.startsWith("src/lsp/lsp_formatter.ts"), "File path must be the section header");
	// Should appear only once
	const countHeader = (text.match(/src\/lsp\/lsp_formatter\.ts/g) || []).length;
	assert.strictEqual(countHeader, 1, "File path should appear exactly once in grouped output");
	assert.ok(text.includes("[function]"), "Must include [function] header");
	assert.ok(text.includes("- 15-26 normalizeUri(uri: string): string"), "Must include bulleted function with parameters");
	assert.ok(res.details.count > 0, "Details count must reflect total raw results");

	// Epistemic guard verification:
	assert.strictEqual(
		guardCallCount,
		res.details.count,
		`globalEpistemicGuard.recordFileSearched must be called for every raw result (${res.details.count})`
	);

	// Restore spy
	globalEpistemicGuard.recordFileSearched = originalRecordFileSearched;

	// 2. No-results behavior
	const emptyRes = await registeredTool.execute(
		"call-ast-test-empty",
		{ name: "NonExistentSymbolxyz12345" },
		undefined,
		() => {},
		ctx
	);
	assert.strictEqual(emptyRes.details.count, 0);
	assert.ok(emptyRes.content[0].text.includes("No AST symbols found"));

	console.log("✓ Task 8 testToolIntegration passed with verified epistemic guard recording!");
}

async function runAll() {
	testBasicGroupingAndLayout();
	testSignatureCleaning();
	testBodyAndTruncationFormatting();
	testAliasAndEdgeCases();
	await testToolIntegration();
}

runAll();
