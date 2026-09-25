import assert from "node:assert/strict";
import { validateConfigDocument } from "../../src/config/kernel_config";
import { clampCommandOutput } from "../../src/safety/output_clamper";

export function testEfficiencyDefaults(): void {
	// 1. Verify default max_lines is calibrated to 100 in schema defaults
	const defaultCfg = validateConfigDocument({});
	assert.equal(defaultCfg.safety.max_lines, 100, "default config safety.max_lines must be 100");

	// 2. Verify clampCommandOutput preserves 80 lines without truncation
	const eightyLines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
	const res80 = clampCommandOutput(eightyLines, "test-cmd");
	assert.equal(res80.truncated, false, "80 lines should not be truncated under 100-line default");

	// 3. Verify 150 lines gets truncated to 100 lines
	const hundredFiftyLines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
	const res150 = clampCommandOutput(hundredFiftyLines, "test-cmd");
	assert.equal(res150.truncated, true, "150 lines should be truncated");
	assert.equal(res150.shownLines, 100, "Should clamp to exactly 100 lines");
	assert.match(res150.text, /Full: .* \(use offset\/limit with read if needed\)\]/, "Must contain actionable inspect hint");

	// 4. Hard Byte Budget Invariant: 100 lines that exceed 20KB must be clamped by bytes
	// 100 lines of 280 chars each = ~28KB, which exceeds the 20KB maxTotalBytes ceiling
	const heavyHundredLines = Array.from({ length: 100 }, (_, i) => `[line ${i + 1}] ` + "X".repeat(270)).join("\n");
	const resHeavy = clampCommandOutput(heavyHundredLines, "test-cmd");
	assert.equal(resHeavy.truncated, true, "Heavy 100-line output must be marked truncated");
	assert(
		Buffer.byteLength(resHeavy.text, "utf8") <= 20 * 1024,
		`Final returned output (${Buffer.byteLength(resHeavy.text, "utf8")} bytes) must strictly obey 20KB budget ceiling`,
	);
	assert(
		resHeavy.shownLines < 100,
		`Lines shown (${resHeavy.shownLines}) must be reduced below 100 when byte budget requires it`,
	);
}
