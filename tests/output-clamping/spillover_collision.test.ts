import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { clampCommandOutput } from "../../src/safety/output_clamper";

export function run(): void {
	console.log("=== Running Spillover Collision & Host Deduplication Test Suite ===");
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-collision-test-"));
	const mockHostSpill = path.join(os.tmpdir(), `pi-bash-${Date.now().toString(16)}.log`);
	fs.writeFileSync(mockHostSpill, "Line 1\nLine 2\nLine 3\n... 50000 lines\n", "utf8");

	try {
		// 1. Host status trailing suffix (e.g. exit code or timeout)
		console.log("1. Testing host status trailing suffix deduplication...");
		const textWithExitCode = `FAIL test/auth.test.ts\nAssertionError: expected 200 to equal 401\n` +
			Array.from({ length: 60 }, (_, i) => `error line ${i + 1}`).join("\n") +
			`\n\n[Showing lines 4000-5000 of 5000. Full output: ${mockHostSpill}]\n\nCommand exited with code 1`;

		const res1 = clampCommandOutput(textWithExitCode, "npm test", {
			maxLines: 15,
			maxTotalBytes: 5000,
			spilloverDir: path.join(tempDir, "spillover"),
		});

		assert.strictEqual(res1.spilloverPath, mockHostSpill, "Host spillover path must be reused even with exit code suffix");
		assert.ok(res1.text.includes("Command exited with code 1"), "Trailing exit code must be preserved in clamped output");
		assert.strictEqual((res1.text.match(/\[Truncated/g) || []).length, 1, "Must contain exactly one truncation footer");

		// 2. Alternative inverted footer format [Full output: ... Truncated: ...]
		console.log("2. Testing alternative inverted host footer format...");
		const invertedFooterText = `FAIL test/auth.test.ts\n` +
			Array.from({ length: 50 }, (_, i) => `error line ${i + 1}`).join("\n") +
			`\n\n[Full output: ${mockHostSpill}. Truncated: 882 lines shown (50.0KB limit)]`;

		const res2 = clampCommandOutput(invertedFooterText, "npm test", {
			maxLines: 15,
			maxTotalBytes: 5000,
			spilloverDir: path.join(tempDir, "spillover"),
		});

		assert.strictEqual(res2.spilloverPath, mockHostSpill, "Must detect and reuse inverted host footer format");
		assert.strictEqual((res2.text.match(/\[Truncated/g) || []).length, 1, "Must contain exactly one truncation footer");

		// 3. Double-clamping with omission recipe must be idempotent
		console.log("3. Testing idempotent double-clamping with inspection recipe...");
		const largeInput = Array.from({ length: 250 }, (_, i) => `log line ${i + 1}`).join("\n");
		const pass1 = clampCommandOutput(largeInput, "cargo test", {
			maxLines: 20,
			maxTotalBytes: 10000,
			spilloverDir: path.join(tempDir, "spillover"),
		});

		assert.ok(pass1.text.includes("To inspect omitted lines"), "Pass 1 should have inspection recipe");

		const pass2 = clampCommandOutput(pass1.text, "cargo test", {
			maxLines: 20,
			maxTotalBytes: 10000,
			spilloverDir: path.join(tempDir, "spillover"),
		});

		assert.strictEqual(pass2.spilloverPath, pass1.spilloverPath, "Pass 2 must reuse existing spillover without duplicating");
		assert.strictEqual((pass2.text.match(/\[Truncated/g) || []).length, 1, "Must not stack duplicate [Truncated] footers");

		// 4. Command timed out suffix
		console.log("4. Testing command timed out suffix handling...");
		const textWithTimeout = `Running heavy benchmark...\n` +
			Array.from({ length: 50 }, (_, i) => `progress ${i + 1}`).join("\n") +
			`\n\n[Showing last 50.0KB of line 100 (line is 120KB). Full output: ${mockHostSpill}]\n\nCommand timed out after 10 seconds`;

		const res4 = clampCommandOutput(textWithTimeout, "cargo bench", {
			maxLines: 15,
			maxTotalBytes: 5000,
			spilloverDir: path.join(tempDir, "spillover"),
		});

		assert.strictEqual(res4.spilloverPath, mockHostSpill, "Must reuse host spillover on timeout");
		assert.ok(res4.text.includes("Command timed out after 10 seconds"), "Must preserve timeout status notice");

		console.log("✓ All Spillover Collision & Host Deduplication Tests Passed!");
	} finally {
		try { fs.unlinkSync(mockHostSpill); } catch {}
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	run();
}
