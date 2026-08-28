// Standalone verification test for the per-session epistemic guard fix.
// Tests:
//   1. Per-session isolation: a file read in session A is not visible in session B
//   2. resetSession only clears one session, not others
//   3. The same path normalizes the same way regardless of relative/absolute
//   4. The default session id works for CLI single-session mode

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { EpistemicGuard, extractInspectedFilesFromCommand } from "../safety/epistemic_guard";

let passed = 0;
let failed = 0;

function expect(label: string, cond: boolean): void {
	if (cond) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}`);
		failed++;
	}
}

async function main(): Promise<void> {
	console.log("\n[per-session epistemic guard verification]\n");

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "epistemic-"));
	const testFile = path.join(tmpDir, "foo.ts");
	fs.writeFileSync(testFile, "// hello\n");

	// Test 1: per-session isolation
	{
		const guard = new EpistemicGuard();
		guard.recordFileRead(testFile, "session_A");
		const checkA = guard.checkReadPrecondition(testFile, "edit", "session_A");
		const checkB = guard.checkReadPrecondition(testFile, "edit", "session_B");
		expect("session_A sees the file as read", checkA.allowed);
		expect("session_B does NOT see the file as read (isolation)", !checkB.allowed);
	}

	// Test 2: resetSession only clears one session
	{
		const guard = new EpistemicGuard();
		const other = path.join(tmpDir, "bar.ts");
		fs.writeFileSync(other, "// bar\n");
		guard.recordFileRead(testFile, "A");
		guard.recordFileRead(other, "B");

		guard.resetSession("A");

		const checkA = guard.checkReadPrecondition(testFile, "edit", "A");
		const checkB = guard.checkReadPrecondition(other, "edit", "B");
		expect("resetSession('A') clears session A", !checkA.allowed);
		expect("resetSession('A') does NOT clear session B", checkB.allowed);
	}

	// Test 3: same file path is recognized regardless of how it was added
	{
		const guard = new EpistemicGuard();
		guard.recordFileRead(testFile, "S");
		const asRelative = path.relative(process.cwd(), testFile);
		const check = guard.checkReadPrecondition(asRelative, "edit", "S");
		expect("relative path resolves to same normalized form", check.allowed);
	}

	// Test 4: default session id works
	{
		const guard = new EpistemicGuard();
		guard.recordFileRead(testFile, "__default__");
		const check = guard.checkReadPrecondition(testFile, "edit", "__default__");
		expect("default session id behaves like a regular session", check.allowed);
	}

	// Test 5: extractInspectedFilesFromCommand still works as before
	{
		const realFile = path.join(tmpDir, "real.py");
		fs.writeFileSync(realFile, "x = 1\n");
		const extracted = extractInspectedFilesFromCommand(`cat "${path.basename(realFile)}"`, tmpDir);
		expect("extractInspectedFilesFromCommand still finds real files", extracted.some((f) => f.endsWith("real.py")));
	}

	// Test 6: write to brand-new file always allowed (no read required)
	{
		const guard = new EpistemicGuard();
		const brandNew = path.join(tmpDir, "brand-new.ts");
		const check = guard.checkReadPrecondition(brandNew, "write", "S");
		expect("write to brand-new file is allowed without prior read", check.allowed);
	}

	// Cleanup
	fs.rmSync(tmpDir, { recursive: true, force: true });

	console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
