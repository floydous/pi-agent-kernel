import * as fs from "node:fs";
import { checkSyntax } from "../../src/editing/syntax-verify";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export function testTypescriptSyntax(): void {
	const ws = createPolyglotWorkspace("syntax_ts_");
	try {
		const tsPath = `${ws.tempDir}/src/app.ts`;
		const original = fs.readFileSync(tsPath, "utf8");

		const validSyntax = checkSyntax(tsPath);
		assertPass("TypeScript valid syntax returns valid=true", validSyntax.valid === true, { validSyntax });

		// Introduce a TypeScript syntax error: missing semicolon and closing brace
		fs.writeFileSync(tsPath, "export class Broken { public badMethod() {", "utf8");
		const brokenSyntax = checkSyntax(tsPath);
		assertPass("TypeScript broken syntax is detected as invalid", brokenSyntax.valid === false, { brokenSyntax });

		// Restore
		fs.writeFileSync(tsPath, original, "utf8");
		logPass("TypeScript syntax verification passed!");
	} finally {
		ws.cleanup();
	}
}
