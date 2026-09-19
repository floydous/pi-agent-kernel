import * as fs from "node:fs";
import { clampCommandOutput } from "../../src/safety/output_clamper";
import { assertPass, logPass } from "../_setup";

export function testByteBudgetEnforcement(): void {
	const raw = Array(10).fill("x".repeat(100)).join("\n");

	// Reproduction of the recorded 500-byte counterexample (E01).
	const ascii = clampCommandOutput(raw, "test", { maxTotalBytes: 500 });
	assertPass("ASCII output respects byte budget", Buffer.byteLength(ascii.text, "utf8") <= 500, { returnedBytes: ascii.returnedBytes });
	assertPass("returnedBytes matches actual UTF-8 length", ascii.returnedBytes === Buffer.byteLength(ascii.text, "utf8"), { returnedBytes: ascii.returnedBytes });
	assertPass("Recovery pointer visible when artifact exists", !ascii.spilloverPath || ascii.text.includes(ascii.spilloverPath), { spilloverPath: ascii.spilloverPath });
	assertPass("Spillover artifact equals received text", !ascii.spilloverPath || fs.readFileSync(ascii.spilloverPath, "utf8") === raw, {});
	if (ascii.spilloverPath) {
		try { fs.unlinkSync(ascii.spilloverPath); } catch {}
	}

	// Unicode budget enforcement with multi-byte characters.
	const unicode = clampCommandOutput(Array(40).fill("界".repeat(300)).join("\n"), "test", { maxTotalBytes: 20480 });
	assertPass("Unicode output respects byte budget", Buffer.byteLength(unicode.text, "utf8") <= 20480, { returnedBytes: unicode.returnedBytes });
	assertPass("No replacement characters introduced", !unicode.text.includes("\uFFFD"), {});
	if (unicode.spilloverPath) {
		try { fs.unlinkSync(unicode.spilloverPath); } catch {}
	}

	// Surrogate-pair boundary: horizontal slicing must not split 😀 across the cut.
	const emoji = clampCommandOutput("😀".repeat(300), "test", { maxLineLength: 301, maxTotalBytes: 20480 });
	assertPass("Surrogate pair not split horizontally", !emoji.text.includes("\uFFFD"), {});
	assertPass("Emoji line truncated", emoji.truncated === true, {});

	// Tiny budget: bounded indication, no partial recovery path.
	const tiny = clampCommandOutput(raw, "test", { maxTotalBytes: 30 });
	assertPass("Tiny budget stays within cap", Buffer.byteLength(tiny.text, "utf8") <= 30, { returnedBytes: tiny.returnedBytes });
	// The text must never show a chopped, unusable path. Either the full pointer
	// is visible, or no pointer appears in the text at all (metadata may remain).
	const pointerShown = tiny.text.includes("Full:");
	assertPass("Tiny budget exposes no partial path", !pointerShown || tiny.text.includes(tiny.spilloverPath!), { text: tiny.text });
	if (tiny.spilloverPath) {
		try { fs.unlinkSync(tiny.spilloverPath); } catch {}
	}

	// Invalid budgets are rejected instead of silently misbehaving.
	for (const budget of [-1, 0.5, NaN, Infinity]) {
		let rejected = false;
		try {
			clampCommandOutput("x", "test", { maxTotalBytes: budget });
		} catch (error) {
			rejected = error instanceof RangeError;
		}
		assertPass(`Invalid budget rejected: ${budget}`, rejected, {});
	}

	// Ordinary small output must remain byte-identical.
	const ordinary = clampCommandOutput("tests passed\nexit 0", "test", { maxTotalBytes: 20480 });
	assertPass("Ordinary output unchanged", ordinary.text === "tests passed\nexit 0" && ordinary.truncated === false, {});

	logPass("Byte budget enforcement verified (ASCII/Unicode/tiny-budget/invalid-budget/surrogate cases)!");
}

export function testFailedWriteDoesNotAdvertisePointer(): void {
	// A nonexistent TMPDIR parent forces the spillover write to fail; the result
	// must not advertise a recovery path that does not exist.
	const originalTmpdir = process.env.TMPDIR;
	const missing = "/proc/self/nonexistent-parent-for-c08-test/logs";
	process.env.TMPDIR = missing;
	try {
		const clamped = clampCommandOutput("x".repeat(1000), "test", { maxTotalBytes: 500 });
		assertPass("No pointer advertised when write failed", !clamped.spilloverPath || fs.existsSync(clamped.spilloverPath), { spilloverPath: clamped.spilloverPath });
		assertPass("Failed-write output still within budget", Buffer.byteLength(clamped.text, "utf8") <= 500, { returnedBytes: clamped.returnedBytes });
	} finally {
		if (originalTmpdir === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = originalTmpdir;
		}
	}
	logPass("Failed spillover write does not advertise a nonexistent recovery path!");
}
