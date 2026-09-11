import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	computeLineHash,
	formatSmartAnchorLines,
	parseAnchorRef,
	preflightSmartAnchorEdits,
	applySmartAnchorEdits,
} from "../../src/editing/smart_anchor";
import { registerEditTool } from "../../src/tools/edit_tool";
import { registerReadTool } from "../../src/tools/read_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";

export async function run(): Promise<void> {
	console.log("=== Smart Anchor Engine Unit & Integration Test Suite ===");

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-anchor-test-"));

	try {
		// 1. Context Hash Calculation
		{
			const lines = [
				"function test() {",
				"  const x = 1;",
				"  return x + 2;",
				"}",
			];
			const h0 = computeLineHash(lines, 0);
			const h1 = computeLineHash(lines, 1);
			const h2 = computeLineHash(lines, 2);
			const h3 = computeLineHash(lines, 3);

			assert.strictEqual(typeof h0, "string");
			assert.strictEqual(h0.length, 2);
			assert.match(h0, /^[0-9A-F]{2}$/);
			assert.notStrictEqual(h0, h1);

			// Normalization: CRLF vs LF
			const linesCRLF = lines.map((l) => l + "\r");
			assert.strictEqual(computeLineHash(linesCRLF, 1), h1);

			// Distant edit does not invalidate local hash (line 1 depends only on line 0, 1, 2)
			const linesDistant = [...lines, "console.log('extra line 4');", "console.log('extra line 5');"];
			assert.strictEqual(computeLineHash(linesDistant, 1), h1);
			console.log("  ✓ Context line hashing and boundary stability verified");
		}

		// 2. Anchor Formatting & Parsing
		{
			const lines = ["first line", "second line", "third line"];
			const formatted = formatSmartAnchorLines(lines, 1, 3);
			assert.match(formatted, /1#[0-9A-F]{2}│first line/);
			assert.match(formatted, /2#[0-9A-F]{2}│second line/);
			assert.match(formatted, /3#[0-9A-F]{2}│third line/);

			// Parsing
			const a1 = parseAnchorRef("42#3F");
			assert.strictEqual(a1.line, 42);
			assert.strictEqual(a1.hash, "3F");

			const a2 = parseAnchorRef(" 105#A9│const val = true;");
			assert.strictEqual(a2.line, 105);
			assert.strictEqual(a2.hash, "A9");

			const a3 = parseAnchorRef("77");
			assert.strictEqual(a3.line, 77);
			assert.strictEqual(a3.hash, undefined);

			const a4 = parseAnchorRef(99);
			assert.strictEqual(a4.line, 99);
			assert.strictEqual(a4.hash, undefined);

			assert.throws(() => parseAnchorRef("0#AA"));
			assert.throws(() => parseAnchorRef("not-an-anchor"));
			console.log("  ✓ Anchor formatting and parsing verified");
		}

		// 3. Preflight & Neighbor Spillover Recovery
		{
			const content = [
				"import { foo } from './foo';",
				"",
				"export function runTask() {",
				"  const a = 10;",
				"  const b = 20;",
				"  return a + b;",
				"}",
			].join("\n");
			const fileLines = content.split("\n");

			// Exact hash match
			const h4 = computeLineHash(fileLines, 3); // line 4: const a = 10;
			const h5 = computeLineHash(fileLines, 4); // line 5: const b = 20;
			const p1 = preflightSmartAnchorEdits(content, [
				{ pos: `4#${h4}`, end: `5#${h5}`, lines: ["  const sum = 30;"] },
			]);
			assert.strictEqual(p1.success, true);
			assert.strictEqual(p1.resolvedSpans?.length, 1);
			assert.strictEqual(p1.resolvedSpans![0].startLine, 4);
			assert.strictEqual(p1.resolvedSpans![0].endLine, 5);

			// Neighbor spillover recovery: model attends to line 3 hash when targeting line 4
			const h3 = computeLineHash(fileLines, 2); // line 3 hash
			const pRecover = preflightSmartAnchorEdits(content, [
				{ pos: `4#${h3}`, end: `5#${h5}`, lines: ["  const sum = 30;"] },
			]);
			assert.strictEqual(pRecover.success, true);
			assert.strictEqual(pRecover.resolvedSpans![0].recoveredNeighbor, true);

			// Stale anchor rejection: arbitrary wrong hash
			const pStale = preflightSmartAnchorEdits(content, [
				{ pos: "4#EE", lines: ["  const fail = true;"] },
			]);
			assert.strictEqual(pStale.success, false);
			assert.match(pStale.error!, /\[E_STALE_ANCHOR\]/);
			assert.match(pStale.error!, /Anchor mismatch at line 4/);

			// Overlapping spans rejection
			const pOverlap = preflightSmartAnchorEdits(content, [
				{ pos: `3#${computeLineHash(fileLines, 2)}`, end: `5#${h5}`, lines: ["// block 1"] },
				{ pos: `4#${h4}`, end: `6#${computeLineHash(fileLines, 5)}`, lines: ["// block 2"] },
			]);
			assert.strictEqual(pOverlap.success, false);
			assert.match(pOverlap.error!, /\[E_EDIT_CONFLICT\]/);

			console.log("  ✓ Preflight and neighbor spillover recovery verified");
		}

		// 4. File Mutation: Pure Deletion, Replacement, & Disjoint Multi-Block
		{
			const filePath = path.join(tempDir, "mutation_sample.ts");
			const original = [
				"export function calculate() {",
				"  // Obsolete debug line 1",
				"  // Obsolete debug line 2",
				"  const val = 100;",
				"  // Obsolete debug line 3",
				"  return val * 2;",
				"}",
			].join("\n");
			fs.writeFileSync(filePath, original, "utf8");

			const lines = original.split("\n");
			const h2 = computeLineHash(lines, 1);
			const h3 = computeLineHash(lines, 2);
			const h5 = computeLineHash(lines, 4);

			// Multi-block disjoint edit:
			// 1. Delete lines 2-3 (obsolete debug lines)
			// 2. Delete line 5 (obsolete debug line 3)
			const res = applySmartAnchorEdits(filePath, [
				{ pos: `2#${h2}`, end: `3#${h3}`, lines: [] },
				{ pos: `5#${h5}`, lines: [] },
			]);

			assert.strictEqual(res.success, true, res.error);
			const updated = fs.readFileSync(filePath, "utf8");
			assert.strictEqual(
				updated,
				[
					"export function calculate() {",
					"  const val = 100;",
					"  return val * 2;",
					"}",
				].join("\n"),
			);
			console.log("  ✓ Disjoint multi-block deletions applied cleanly bottom-to-top");
		}

		// 5. Tool Integration: read and edit with EpistemicGuard
		{
			const filePath = path.join(tempDir, "tool_integration.ts");
			const code = [
				"export function greet(name: string): string {",
				"  const message = 'Hello, ' + name;",
				"  return message;",
				"}",
			].join("\n");
			fs.writeFileSync(filePath, code, "utf8");

			const sessionId = "smart-anchor-session";
			const mockCtx = { cwd: tempDir, sessionManager: { getSessionId: () => sessionId } };
			const registeredTools: Record<string, any> = {};
			const mockPi: any = {
				registerTool(def: any) {
					registeredTools[def.name] = def;
				},
			};

			registerReadTool(mockPi, {
				getSessionId: () => sessionId,
				getConfig: () => ({ safety: { enable_epistemic_guard: true }, editing: { mode: "smart_anchor", default_anchors: true, read_mode: "anchored" } } as any),
			});
			registerEditTool(mockPi, {
				getSessionId: () => sessionId,
				getConfig: () => ({ safety: { enable_epistemic_guard: true }, editing: { mode: "smart_anchor", default_anchors: true, read_mode: "anchored" } } as any),
			});

			const readTool = registeredTools["read"];
			const editTool = registeredTools["edit"];

			// Step 1: Read file (authorizes epistemic read and returns anchors)
			const readRes = await readTool.execute("call-1", { path: "tool_integration.ts" }, undefined, undefined, mockCtx);
			assert.strictEqual(readRes.isError, undefined);
			const readText = readRes.content[0].text;
			assert.match(readText, /1#[0-9A-F]{2}│export function greet/);
			assert.match(readText, /2#[0-9A-F]{2}│  const message/);

			// Parse anchor from line 2
			const line2Match = readText.match(/(\d+#[0-9A-F]{2})│\s*const message/);
			assert.ok(line2Match, "Line 2 anchor not found in read output");
			const line2Anchor = line2Match[1];

			// Step 2: Edit file using the anchor from read output
			const editRes = await editTool.execute(
				"call-2",
				{
					path: "tool_integration.ts",
					pos: line2Anchor,
					lines: ["  const message = `Welcome, ${name}!`;"],
				},
				undefined,
				undefined,
				mockCtx,
			);
			assert.strictEqual(editRes.isError, false, JSON.stringify(editRes));

			const finalContent = fs.readFileSync(filePath, "utf8");
			assert.ok(finalContent.includes("Welcome, ${name}!"), "File not updated as expected");
			console.log("  ✓ End-to-end read-to-edit tool integration with Smart Anchors verified");
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}

	console.log("✓ Smart Anchor Engine test suite completed successfully!\n");
}
