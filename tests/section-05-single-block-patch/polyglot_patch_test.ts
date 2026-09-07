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
		// Patch a unique signature in the realistic TypeScript fixture
		const tsPatch = applySurgicalPatch(
			tsPath,
			"this._active = false;",
			"this._active = false;\n        this._startTime = Date.now();"
		);
		assertPass("TypeScript patch succeeds", tsPatch.success, { tsPatch });
		assertPass(
			"File updated with new content",
			fs.readFileSync(tsPath, "utf8").includes("_startTime"),
			{ content: fs.readFileSync(tsPath, "utf8") }
		);

		// 2. Rust patch
		const rsPath = path.join(ws.tempDir, "src/worker.rs");
		const rsPatch = applySurgicalPatch(
			rsPath,
			"Ok(())",
			"println!(\"processing {}\", job_name);\n        Ok(())"
		);
		assertPass("Rust patch succeeds", rsPatch.success, { rsPatch });

		// 3. Java patch (valid edit) — use a string from the new fixture
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const javaPatch = applySurgicalPatch(
			javaPath,
			"if (shutdown) {",
			"if (shutdown || true) {"
		);
		assertPass("Java patch succeeds", javaPatch.success, { javaPatch });

		logPass("Polyglot single-block patching and syntax verification passed!");
	} finally {
		ws.cleanup();
	}
}
