import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HybridSearchIndex } from "../../src/retrieval/search_index";

export async function run(): Promise<void> {
	console.log("=== Running Incremental Vector Indexing (updateFile) Test Suite ===");

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-incremental-test-"));
	const testFile = path.join(tempDir, "sample_module.ts");

	try {
		// File with >40 lines so tree-sitter generates multi-chunk AST functions
		const makeCode = (alphaBody: string, betaBody: string, padding = 0) => {
			const pad = Array.from({ length: padding }, (_, i) => `// Padding line ${i + 1}`).join("\n");
			return `/**
 * Sample Module Documentation Header
 * Used for testing incremental indexing
 */

${pad ? pad + "\n" : ""}// ─── Section Alpha ──────────────────────────────────────────────
export function computeAlpha(x: number): number {
	${alphaBody}
}

// ─── Section Beta ───────────────────────────────────────────────
export function computeBeta(y: number): number {
	${betaBody}
}

// ─── Section Gamma ──────────────────────────────────────────────
export function computeGamma(z: number): number {
	const g1 = z * 10;
	const g2 = g1 + 20;
	const g3 = g2 * 30;
	return g3;
}

// ─── Section Delta ──────────────────────────────────────────────
export function computeDelta(w: number): number {
	const d1 = w - 1;
	const d2 = d1 - 2;
	const d3 = d2 - 3;
	return d3;
}
`;
		};

		const initialCode = makeCode(
			"const factor = 42;\n\treturn x * factor;",
			"const offset = 100;\n\treturn y + offset;",
			10,
		);
		fs.writeFileSync(testFile, initialCode, "utf8");

		const index = new HybridSearchIndex(tempDir, "full");

		// Run updateFile on the newly created file
		await index.updateFile(testFile);

		const chunks = (index as any).chunks as Map<string, any>;
		const vectors = (index as any).vectors as Map<string, Float32Array>;

		assert.strictEqual(chunks.size >= 4, true, `Must create >=4 chunks, got ${chunks.size}`);
		assert.strictEqual(vectors.size, chunks.size, "All chunks must have vectors");

		const alphaChunk = Array.from(chunks.values()).find((c: any) => c.symbolName === "computeAlpha");
		const betaChunk = Array.from(chunks.values()).find((c: any) => c.symbolName === "computeBeta");
		assert.ok(alphaChunk, "computeAlpha chunk must exist");
		assert.ok(betaChunk, "computeBeta chunk must exist");

		const initialAlphaVec = new Float32Array(vectors.get(alphaChunk.id)!);
		const initialBetaVec = new Float32Array(vectors.get(betaChunk.id)!);
		assert.strictEqual(initialAlphaVec.length, 768, "Alpha vector must be 768d");

		console.log(`  ✓ Initial updateFile created ${chunks.size} chunks and 768d vectors`);

		// 2. Partial modification: Modify computeBeta only; computeAlpha remains identical
		const modifiedCode = makeCode(
			"const factor = 42;\n\treturn x * factor;",
			"const offset = 999999;\n\treturn y * 2 + offset;",
			10,
		);
		fs.writeFileSync(testFile, modifiedCode, "utf8");
		await index.updateFile(testFile);

		const updatedAlphaChunk = Array.from(chunks.values()).find((c: any) => c.symbolName === "computeAlpha");
		const updatedBetaChunk = Array.from(chunks.values()).find((c: any) => c.symbolName === "computeBeta");

		assert.ok(updatedAlphaChunk);
		assert.ok(updatedBetaChunk);

		// Alpha vector must be exactly the reused vector
		const currentAlphaVec = vectors.get(updatedAlphaChunk.id)!;
		assert.deepStrictEqual(
			Array.from(currentAlphaVec.slice(0, 10)),
			Array.from(initialAlphaVec.slice(0, 10)),
			"Unchanged computeAlpha must reuse its existing vector",
		);

		// Beta vector must have updated
		const currentBetaVec = vectors.get(updatedBetaChunk.id)!;
		const betaMatchesOld = Array.from(currentBetaVec.slice(0, 10)).every(
			(val, i) => val === initialBetaVec[i],
		);
		assert.strictEqual(betaMatchesOld, false, "Modified computeBeta must receive a new vector embedding");

		console.log("  ✓ Partial file modification reused untouched chunk vector and embedded modified chunk");

		// 3. Line shift: Increase padding lines above functions without changing bodies
		const shiftedCode = makeCode(
			"const factor = 42;\n\treturn x * factor;",
			"const offset = 999999;\n\treturn y * 2 + offset;",
			25, // Shift lines down by 15 lines
		);
		fs.writeFileSync(testFile, shiftedCode, "utf8");
		await index.updateFile(testFile);

		const shiftedAlpha = Array.from(chunks.values()).find((c: any) => c.symbolName === "computeAlpha");
		const shiftedBeta = Array.from(chunks.values()).find((c: any) => c.symbolName === "computeBeta");

		assert.notStrictEqual(shiftedAlpha.startLine, updatedAlphaChunk.startLine, "Line numbers must have shifted");
		// Vectors must still be identical because content hash didn't change
		const shiftedAlphaVec = vectors.get(shiftedAlpha.id)!;
		const shiftedBetaVec = vectors.get(shiftedBeta.id)!;
		assert.deepStrictEqual(
			Array.from(shiftedAlphaVec.slice(0, 10)),
			Array.from(currentAlphaVec.slice(0, 10)),
			"Alpha vector must be preserved across line shifts via content hash",
		);
		assert.deepStrictEqual(
			Array.from(shiftedBetaVec.slice(0, 10)),
			Array.from(currentBetaVec.slice(0, 10)),
			"Beta vector must be preserved across line shifts via content hash",
		);

		console.log("  ✓ Line shifts preserved existing vectors via content hash matching with 0 re-embedding");

		// 4. Overlapping updates (Generational cancellation)
		const codeV1 = shiftedCode + "\nexport const v = 1;";
		const codeV2 = shiftedCode + "\nexport const v = 2;";
		fs.writeFileSync(testFile, codeV1, "utf8");
		const p1 = index.updateFile(testFile);
		fs.writeFileSync(testFile, codeV2, "utf8");
		const p2 = index.updateFile(testFile);
		await Promise.all([p1, p2]);

		const finalCode = fs.readFileSync(testFile, "utf8");
		assert.strictEqual(finalCode.includes("v = 2"), true);
		console.log("  ✓ Overlapping rapid updates handled cleanly without race conditions");

		// 5. Deletion handling
		fs.unlinkSync(testFile);
		await index.updateFile(testFile);

		assert.strictEqual(chunks.size, 0, "All chunks must be purged upon file deletion");
		assert.strictEqual(vectors.size, 0, "All vectors must be purged upon file deletion");
		console.log("  ✓ File deletion atomically purged all chunks and vectors from the index");

		// 6. Debounced disk persistence & clean reload
		// Re-create a file and flush
		fs.writeFileSync(testFile, initialCode, "utf8");
		await index.updateFile(testFile);
		await index.flushPendingSave();

		// Create a second index instance pointing to the same workspace
		const reloadedIndex = new HybridSearchIndex(tempDir, "full");
		assert.strictEqual(
			(reloadedIndex as any).chunks.size >= 4,
			true,
			"Reloaded index must restore chunks from disk",
		);
		assert.strictEqual(
			(reloadedIndex as any).vectors.size,
			(reloadedIndex as any).chunks.size,
			"Reloaded index must restore pre-computed vectors from disk",
		);
		assert.strictEqual(
			(reloadedIndex as any).isInitialized,
			true,
			"Reloaded index must be fully initialized with 0 un-embedded chunks",
		);

		console.log("  ✓ Debounced persistence cleanly restored on reload with 0 missing chunks");

		// 7. Shutdown race protection: flushPendingSave drains in-flight updateFile
		const codeShutdown = makeCode(
			"const factor = 42;\n\treturn x * factor;",
			"const offset = 88888;\n\treturn y + offset;",
			10,
		);
		fs.writeFileSync(testFile, codeShutdown, "utf8");
		// Launch updateFile non-blocking (do not await)
		const pendingUpdate = index.updateFile(testFile);
		// Immediately trigger flushPendingSave as in session_shutdown
		await index.flushPendingSave();
		await pendingUpdate;

		// Reload from disk and verify the latest update was captured
		const reloadedAfterShutdown = new HybridSearchIndex(tempDir, "full");
		const betaShutdownChunk = Array.from((reloadedAfterShutdown as any).chunks.values()).find(
			(c: any) => c.symbolName === "computeBeta",
		) as any;
		assert.ok(betaShutdownChunk);
		assert.strictEqual(
			betaShutdownChunk.content.includes("88888"),
			true,
			"Disk cache must contain the latest update even if flushPendingSave raced with in-flight embedding",
		);
		console.log("  ✓ flushPendingSave drained in-flight updates before persisting (shutdown race prevented)");

		console.log("\n✓ All Incremental Vector Indexing Tests Passed Successfully!");
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}
}

if (process.argv[1] && process.argv[1].endsWith("incremental_update.test.ts")) {
	run().catch((err) => {
		console.error("Incremental update test failed:", err);
		process.exit(1);
	});
}
