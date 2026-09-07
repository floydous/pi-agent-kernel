import * as fs from "node:fs";
import { checkSyntax } from "../../src/editing/syntax-verify";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testPythonSyntax(): void {
	const ws = createTestWorkspace("syntax_py_");
	try {
		const validSyntax = checkSyntax(ws.calculatorPath);
		assertPass("Python valid syntax returns valid=true", validSyntax.valid === true, { validSyntax });

		fs.writeFileSync(ws.calculatorPath, "def broken_func(:", "utf8");
		const brokenSyntax = checkSyntax(ws.calculatorPath);
		assertPass("Python broken syntax returns valid=false", brokenSyntax.valid === false, { brokenSyntax });

		logPass("Python syntax verification passed!");
	} finally {
		ws.cleanup();
	}
}
