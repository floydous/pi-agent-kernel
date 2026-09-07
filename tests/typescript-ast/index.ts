// TypeScript Full AST & Parameter Scope Hover Suite

import { runSuite } from "../_setup";
import { testTypescriptAst } from "./ts_ast_test";

export async function run(): Promise<void> {
	await runSuite("TypeScript Full AST & Parameter Scope Hover Suite", async () => {
		await testTypescriptAst();
	});
}

