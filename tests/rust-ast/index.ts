// Rust Full AST, Struct Bleed Defense, Variable Hover, Comment Filtering Suite

import { runSuite } from "../_setup";
import { testRustAst } from "./rust_ast_test";

export async function run(): Promise<void> {
	await runSuite("Rust AST & Bleed Defense Suite", async () => {
		await testRustAst();
	});
}

