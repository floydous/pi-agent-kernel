// Section 21: TypeScript Full AST & Parameter Scope Hover Suite

import { runSection } from "../_setup";
import { testTypescriptAst } from "./ts_ast_test";

export async function runSection21(): Promise<void> {
	await runSection("21. TypeScript Full AST & Parameter Scope Hover Suite", async () => {
		await testTypescriptAst();
	});
}

runSection21().catch((err) => {
	console.error(err);
	process.exit(1);
});
