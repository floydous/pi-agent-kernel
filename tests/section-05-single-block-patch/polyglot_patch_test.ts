import * as fs from "node:fs";
import * as path from "node:path";
import { applySurgicalPatch } from "../../src/editing/patch";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export function testPolyglotSingleBlock(): void {
	const ws = createPolyglotWorkspace("patch_polyglot_");
	try {
		// 1. TypeScript patch
		const tsPath = path.join(ws.tempDir, "src/app.ts");
		const originalTs = fs.readFileSync(tsPath, "utf8");
		const tsPatch = applySurgicalPatch(
			tsPath,
			"this._active = true;",
			"this._active = true;\n        console.log('Server started');"
		);
		assertPass("TypeScript patch succeeds", tsPatch.success, { tsPatch });
		assertPass(
			"File updated with new content",
			fs.readFileSync(tsPath, "utf8").includes("console.log('Server started')"),
			{ content: fs.readFileSync(tsPath, "utf8") }
		);

		// Syntax error rejection in TypeScript
		const badTsPatch = applySurgicalPatch(
			tsPath,
			"console.log('Server started');",
			"console.log('Server started'" // missing closing paren and semicolon
		);
		assertPass("Malformed TypeScript rejected by syntax gate", !badTsPatch.success, { badTsPatch });

		// 2. Rust patch
		const rsPath = path.join(ws.tempDir, "src/worker.rs");
		const rsPatch = applySurgicalPatch(
			rsPath,
			"Ok(())",
			"println!(\"processing {}\", job_name);\n        Ok(())"
		);
		assertPass("Rust patch succeeds", rsPatch.success, { rsPatch });

		// 3. Java patch
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const javaPatch = applySurgicalPatch(
			javaPath,
			"System.out.println(\"Processing: \" + amount);",
			"System.out.println(\"Processing payment: \" + amount);"
		);
		assertPass("Java patch succeeds", javaPatch.success, { javaPatch });

		logPass("Polyglot single-block patching and syntax verification passed!");
	} finally {
		ws.cleanup();
	}
}
