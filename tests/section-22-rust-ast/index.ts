// Section 22: Rust Full AST, Struct Bleed Defense, Variable Hover, Comment Filtering Suite

import { runSection } from "../_setup";
import { testRustAst } from "./rust_ast_test";

export async function runSection22(): Promise<void> {
	await runSection("22. Rust AST & Bleed Defense Suite", async () => {
		await testRustAst();
	});
}

runSection22().catch((err) => {
	console.error(err);
	process.exit(1);
});
