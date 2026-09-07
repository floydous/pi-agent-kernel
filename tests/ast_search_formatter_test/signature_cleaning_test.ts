import assert from "node:assert";
import { cleanSignature } from "../../src/tools/ast_search_formatter";
import { logPass } from "../_setup";

export function testSignatureCleaning(): void {
	assert.strictEqual(
		cleanSignature("public checkReadPrecondition(path: string): boolean", "checkReadPrecondition"),
		"checkReadPrecondition(path: string): boolean"
	);
	assert.strictEqual(
		cleanSignature("function normalizeUri(uri: string): string", "normalizeUri"),
		"normalizeUri(uri: string): string"
	);
	assert.strictEqual(
		cleanSignature("pub async fn dispatch_response(resp: Response) -> Result<()>", "dispatch_response"),
		"async dispatch_response(resp: Response) -> Result<()>"
	);

	// Multiline Python
	const pySig = `def process_transaction(
    self,
    user_id: str,
    amount: float
) -> bool:`;
	assert.strictEqual(
		cleanSignature(pySig, "process_transaction"),
		"process_transaction( self, user_id: str, amount: float ) -> bool:"
	);

	// Empty fallbacks
	assert.strictEqual(cleanSignature("", "mySymbol"), "mySymbol");
	assert.strictEqual(cleanSignature("", ""), "unknown");

	// Modifiers
	assert.strictEqual(
		cleanSignature("public static async compute(x: number): Promise<number>", "compute"),
		"static async compute(x: number): Promise<number>"
	);

	// Polyglot: Rust unsafe, PHP/JS static, Java void, TS accessors, abstract
	assert.strictEqual(cleanSignature("pub unsafe fn raw_alloc(size: usize) -> *mut u8", "raw_alloc"), "unsafe raw_alloc(size: usize) -> *mut u8");
	assert.strictEqual(cleanSignature("static function parse(input: string): Data", "parse"), "static parse(input: string): Data");
	assert.strictEqual(cleanSignature("public void run()", "run"), "void run()");
	assert.strictEqual(cleanSignature("private static void execute()", "execute"), "static void execute()");
	assert.strictEqual(cleanSignature("get value(): string", "value"), "value(): string");
	assert.strictEqual(cleanSignature("set value(v: string)", "value"), "value(v: string)");
	assert.strictEqual(cleanSignature("abstract class Shape", "Shape"), "Shape");

	logPass("Section 38: Conservative signature cleaning verified across 6+ languages!");
}
