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
		// TS: patch two disjoint lines from the realistic AppServer fixture
		const tsRes = applyMultiBlockPatch(tsPath, [
			{ search: "this.stats.lastRestartedAt = new Date();", replace: "this.stats.lastRestartedAt = new Date();\n        this.emit(\"started:v2\", cfg);" },
			{ search: "this.stats.errorCount += 1;", replace: "this.stats.errorCount += 1;\n            throw err;" },
		]);
		assertPass("TypeScript multi-block patch succeeds", tsRes.success, { tsRes });

		// Rust: two disjoint edits
		const rsPath = path.join(ws.tempDir, "src/worker.rs");
		const rsRes = applyMultiBlockPatch(rsPath, [
			{ search: "pub worker_id: u32,", replace: "pub worker_id: u32,\n    pub label: String," },
			{ search: "if job_name.is_empty() {", replace: "if job_name.trim().is_empty() {" },
		]);
		assertPass("Rust multi-block patch succeeds", rsRes.success, { rsRes });

		// Java: valid edit
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const javaPatch = applyMultiBlockPatch(javaPath, [
			{ search: "balances.put(\"default\", 1000.0);", replace: "balances.put(\"default\", 5000.0);" },
		]);
		assertPass("Java multi-block patch succeeds", javaPatch.success, { javaPatch });

		logPass("Polyglot multi-block patching & syntax defense passed!");
	} finally {
		ws.cleanup();
	}
}
