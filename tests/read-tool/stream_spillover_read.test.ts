import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { clampCommandOutput } from "../../src/safety/output_clamper";
import { registerReadTool } from "../../src/tools/read_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";

export async function run(): Promise<void> {
	console.log("=== Running Streamed Spillover & Large File Read Test Suite ===");
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stream-read-test-"));
	const previousPiDir = process.env.PI_DIR;
	process.env.PI_DIR = tempDir;

	try {
		let readTool: any;
		const mockPi = {
			registerTool(t: any) { readTool = t; }
		};
		registerReadTool(mockPi as any, {
			getSessionId: () => "stream-read-session",
			getConfig: () => ({ safety: { max_total_bytes: 20 * 1024 }, editing: { read_mode: "plain", default_anchors: false } }) as any,
		});

		// 1. Create a 16 MB spillover file via clampCommandOutput
		console.log("1. Testing 16 MB clamped spillover reading with offset and limit...");
		const lineTmpl = (i: number) => `PASS tests/unit/worker_${i % 100}.test.ts (${i}ms) - assertion ${i} verified with status 200 OK\n`;
		const targetBytes = 16 * 1024 * 1024;
		const repeats = Math.ceil(targetBytes / lineTmpl(1).length);
		const ws = fs.createWriteStream(path.join(tempDir, "big_raw.log"));
		for (let i = 1; i <= repeats; i++) {
			ws.write(lineTmpl(i));
		}
		await new Promise((r) => ws.end(r));

		const rawContent = fs.readFileSync(path.join(tempDir, "big_raw.log"), "utf8");
		const clamped = clampCommandOutput(rawContent, "npm test --verbose", {
			maxLines: 100,
			maxTotalBytes: 20 * 1024,
			spilloverDir: path.join(tempDir, "spillover"),
		});

		assert.ok(clamped.truncated);
		assert.ok(clamped.spilloverPath);
		assert.ok(fs.statSync(clamped.spilloverPath).size >= 16 * 1024 * 1024);

		// Read lines 1000..1049 of the 16 MB spillover file
		const readRes = await readTool.execute("read-spillover", {
			path: clamped.spilloverPath,
			offset: 1000,
			limit: 50,
		}, null, () => {}, { cwd: tempDir });

		assert.ok(!readRes.isError, `Read must succeed on 16MB spillover: ${JSON.stringify(readRes)}`);
		assert.equal(readRes.details?.streamed, true);
		assert.equal(readRes.details?.limit, 50);
		assert.equal(readRes.details?.offset, 1000);
		const lines = readRes.content[0].text.split("\n");
		assert.ok(lines[0].includes("assertion 1000 verified"));
		assert.ok(lines[49].includes("assertion 1049 verified"));
		assert.ok(lines.length >= 50);

		// 2. Test unwindowed read on spillover file (should stream default 250 lines with continuation hint)
		console.log("2. Testing unwindowed read on 16 MB spillover file (defaults to 250 lines)...");
		const unwindowedSpill = await readTool.execute("read-spill-unwindowed", {
			path: clamped.spilloverPath,
		}, null, () => {}, { cwd: tempDir });
		if (unwindowedSpill.isError) {
			console.log("unwindowedSpill error output:", unwindowedSpill.content[0]?.text);
		}

		assert.ok(!unwindowedSpill.isError);
		assert.equal(unwindowedSpill.details?.streamed, true);
		assert.equal(unwindowedSpill.details?.limit, 250);
		assert.ok(unwindowedSpill.content[0].text.includes("[truncated:"));

		// 3. Test that unwindowed read on regular >5 MB source file STILL fails closed
		console.log("3. Testing unwindowed read on regular 5MB+1 source file (must fail closed)...");
		const hugeSource = path.join(tempDir, "huge.ts");
		const fdHuge = fs.openSync(hugeSource, "w");
		fs.ftruncateSync(fdHuge, 5 * 1024 * 1024 + 1);
		fs.closeSync(fdHuge);

		const rejectedHuge = await readTool.execute("read-huge", {
			path: hugeSource,
		}, null, () => {}, { cwd: tempDir });

		assert.equal(rejectedHuge.isError, true);
		assert.match(rejectedHuge.content[0].text, /maximum in-memory source size/);

		// 4. Test that windowed read on regular >5 MB data file succeeds in O(1) memory
		console.log("4. Testing windowed read on regular 8 MB workspace data file...");
		const largeData = path.join(tempDir, "data.log");
		const wsData = fs.createWriteStream(largeData);
		for (let i = 1; i <= 250_000; i++) {
			wsData.write(`[DATA LINE ${i}] metric_value=${i * 3.14}\n`);
		}
		await new Promise((r) => wsData.end(r));

		const readData = await readTool.execute("read-data", {
			path: largeData,
			offset: 150_000,
			limit: 25,
		}, null, () => {}, { cwd: tempDir });

		assert.ok(!readData.isError);
		assert.equal(readData.details?.streamed, true);
		assert.equal(readData.details?.limit, 25);
		assert.ok(readData.content[0].text.includes("[DATA LINE 150000]"));
		assert.ok(readData.content[0].text.includes("[DATA LINE 150024]"));

		// 5. Test newline-free 16 MB file (O(N) heap defense)
		console.log("5. Testing newline-free 16 MB file (no \\n bytes)...");
		const singleLineFile = path.join(tempDir, "single_line_16mb.bin");
		const wsSingle = fs.createWriteStream(singleLineFile);
		const block64k = "Z".repeat(64 * 1024);
		for (let i = 0; i < 256; i++) {
			wsSingle.write(block64k);
		}
		await new Promise((r) => wsSingle.end(r));

		const singleRes = await readTool.execute("read-single-line", {
			path: singleLineFile,
			offset: 1,
			limit: 10,
		}, null, () => {}, { cwd: tempDir });

		assert.ok(!singleRes.isError);
		assert.equal(singleRes.details?.singleLineTruncated, true);
		assert.ok(singleRes.content[0].text.includes("Line 1 truncated at 50 KB"));

		// 6. Test binary file detection on oversized file
		console.log("6. Testing binary file guard on oversized file (0x00 byte)...");
		const binFile = path.join(tempDir, "sample.bin");
		const binFd = fs.openSync(binFile, "w");
		fs.ftruncateSync(binFd, 6 * 1024 * 1024);
		fs.writeSync(binFd, Buffer.from([0x00, 0x01, 0x02]), 0, 3, 50);
		fs.closeSync(binFd);

		const binRes = await readTool.execute("read-bin", {
			path: binFile,
			offset: 1,
			limit: 10,
		}, null, () => {}, { cwd: tempDir });

		assert.equal(binRes.isError, true);
		assert.match(binRes.content[0].text, /Binary file cannot be displayed as text/);

		// 7. Test batch read recording epistemic evidence for streamed files
		console.log("7. Testing batch read records epistemic evidence for streamed files...");
		const normalSample = path.join(tempDir, "sample_normal.txt");
		fs.writeFileSync(normalSample, "first line\nsecond line\n");

		const batchRes = await readTool.execute("read-batch", {
			paths: [normalSample, clamped.spilloverPath],
		}, null, () => {}, { cwd: tempDir });

		assert.ok(!batchRes.isError);
		assert.ok(batchRes.content[0].text.includes("sample_normal.txt"));
		assert.ok(batchRes.content[0].text.includes(path.basename(clamped.spilloverPath)));

		const evidence = globalEpistemicGuard.getEvidence(clamped.spilloverPath, "stream-read-session", tempDir);
		assert.ok(evidence !== null, "Streamed spillover file in batch mode must have epistemic evidence");
		assert.ok(evidence?.coverage?.ranges?.length > 0, "Evidence ranges must be populated");

		console.log("\n✓ All Streamed Spillover & Large File Read Tests Passed!");
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	void run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
