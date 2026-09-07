import * as fs from "node:fs";
import * as path from "node:path";
import { applyMultiBlockPatch } from "../../src/editing/patch";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export function testPolyglotMultiBlock(): void {
	const ws = createPolyglotWorkspace("multi_polyglot_");
	try {
		// TypeScript: two disjoint edits
		const tsPath = path.join(ws.tempDir, "src/app.ts");
		const tsOriginal = fs.readFileSync(tsPath, "utf8");
		const tsRes = applyMultiBlockPatch(tsPath, [
			{ search: "private _active: boolean = false;", replace: "private _active: boolean = false;\n    private _startTime: number = 0;" },
			{ search: "this._active = true;", replace: "this._active = true;\n        this._startTime = Date.now();" },
		]);
		assertPass("TypeScript multi-block patch succeeds", tsRes.success, { tsRes });
		assertPass(
			"TypeScript file contains both new declarations",
			fs.readFileSync(tsPath, "utf8").includes("_startTime"),
			{ content: fs.readFileSync(tsPath, "utf8") }
		);

		// Rust: two disjoint edits
		const rsPath = path.join(ws.tempDir, "src/worker.rs");
		const rsRes = applyMultiBlockPatch(rsPath, [
			{ search: "pub worker_id: u32,", replace: "pub worker_id: u32,\n    pub label: String," },
			{ search: "Ok(())", replace: "println!(\"done\");\n        Ok(())" },
		]);
		assertPass("Rust multi-block patch succeeds", rsRes.success, { rsRes });
		assertPass(
			"Rust file contains the new field and println",
			fs.readFileSync(rsPath, "utf8").includes("pub label: String") &&
				fs.readFileSync(rsPath, "utf8").includes("println!(\"done\")"),
			{ content: fs.readFileSync(rsPath, "utf8") }
		);

		// Java patch (valid edit) — should succeed cleanly
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const javaPatch = applyMultiBlockPatch(javaPath, [
			{ search: "System.out.println(\"Processing: \" + amount);", replace: "System.out.println(\"Processing payment: \" + amount);" },
		]);
		assertPass("Java patch succeeds", javaPatch.success, { javaPatch });

		logPass("Polyglot multi-block patching & syntax defense passed!");
	} finally {
		ws.cleanup();
	}
}
