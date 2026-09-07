import * as fs from "node:fs";
import * as path from "node:path";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { applySurgicalPatch } from "../../src/editing/patch";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testSequentialEdits(): void {
	const ws = createTestWorkspace("mutation_seq_");
	try {
		const guard = new EpistemicGuard();
		const SESSION = "mutation_seq_test";

		const seqPath = path.join(ws.tempDir, "sequential.py");
		const initialSeq = `import sys\n\ndef calculate_fee(amount: float) -> float:\n    return amount * 0.05\n\ndef calculate_total(amount: float) -> float:\n    return amount + calculate_fee(amount)\n`;
		fs.writeFileSync(seqPath, initialSeq, "utf8");

		// Initial complete read
		guard.recordFileRead(seqPath, SESSION, ws.tempDir, initialSeq, {
			coverage: { complete: true, ranges: [{ startLine: 1, endLine: 7 }] },
			provenance: "read",
		});

		// First edit should be allowed (file was just fully read)
		const check1 = guard.checkReadPrecondition(seqPath, "edit", SESSION, ws.tempDir, true, [{ startLine: 1, endLine: 2 }]);
		assertPass("First edit after full read is allowed", check1.allowed === true, { check1 });

		// Apply the first edit
		const result1 = applySurgicalPatch(seqPath, "import sys", "import os, sys");
		assertPass("First patch succeeds", result1.success, { result1 });

		// Second edit (without re-reading) should be blocked because the file changed
		// since the original read. This is the correct epistemic-guard behavior.
		const check2 = guard.checkReadPrecondition(seqPath, "edit", SESSION, ws.tempDir, true, [{ startLine: 1, endLine: 2 }]);
		assertPass("Second sequential edit is blocked because file changed since read (drift detection)", check2.allowed === false, { check2 });

		logPass("Sequential edits continuity verified without redundant reads!");
	} finally {
		ws.cleanup();
	}
}
