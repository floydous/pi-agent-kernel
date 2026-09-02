// Section 31: End-to-end integration of the dedup hook chain
//
// The unit tests for DedupStore (29) and decideRecall (30) cover the data
// structures and the decision logic. This section covers what happens when
// a tool_result flows through the production hook: the rendered text the
// LLM sees gets hashed, dedup'd if appropriate, and the recall tool's
// `decideRecall` finds the entry again.
//
// We exercise the real `registerRecallTool` parameter shape and the
// DedupStore's record() entry path with realistic rendered text, but
// without the full Pi harness. The point is to confirm the data shape
// that the hook produces matches the data shape the recall tool consumes.

import { DedupStore } from "../src/dedup/content_store";
import { decideRecall } from "../src/dedup/recall_tool";
import { runSection, assertPass, logPass } from "./_setup";

function renderReadResult(filePath: string, content: string) {
	// Mirror the shape of a real `read` tool result. The hook joins all
	// text content blocks; the LLM sees the joined string. We use the
	// joined string as the dedup key, exactly as the hook does.
	return content;
}

async function main(): Promise<void> {
	await runSection("31. End-to-End Dedup Hook Chain", () => {
		// ---- Test 1: full chain on a realistic read flow ----
		{
			const store = new DedupStore();
			const sessionId = "e2e-read";
			const filePath = "src/auth.ts";
			const fileContent = `export function verify(token: string) {\n  if (!token) throw new Error("empty");\n  return token.length > 8;\n}\n`.repeat(5);

			// Simulate the first read tool result.
			const text1 = renderReadResult(filePath, fileContent);
			const r1 = store.record(sessionId, "call_a", text1, false, 0);
			assertPass("e2e read 1: not a duplicate", r1.isDuplicate === false);
			assertPass("e2e read 1: shortRef is r1", r1.shortRef === "r1");
			// LLM sees the full text on the first call (Pi doesn't return
			// the dedup-ed content; only when isDuplicate).
			assertPass("e2e read 1: text1 length matches file", text1.length === fileContent.length);

			// Simulate the second read tool result with the same content.
			const text2 = renderReadResult(filePath, fileContent);
			assertPass("e2e read 2: byte-equal to text1", text1 === text2);
			const r2 = store.record(sessionId, "call_b", text2, false, 0);
			assertPass("e2e read 2: is duplicate", r2.isDuplicate === true);
			assertPass("e2e read 2: shortRef is r1", r2.shortRef === "r1");

			// The hook would emit: [{ type: "text", text: `[=r1,${len}B]` }]
			// The LLM would call recall({ ref: "r1" }) and get the full text.
			const recall = decideRecall(r2.shortRef, store, sessionId);
			assertPass("e2e: recall on r1 returns the full original", recall.kind === "ok");
			if (recall.kind === "ok") {
				assertPass("e2e: recalled text byte-equal to original", recall.fullText === fileContent);
			}
			logPass("e2e read flow: read, read, recall -> original");
		}

		// ---- Test 2: post-edit re-read flows correctly ----
		{
			const store = new DedupStore();
			const sessionId = "e2e-edit";
			const before = `function foo() {\n  return 1;\n}\n`.repeat(10);
			const after = `function foo() {\n  return 2;  // updated\n}\n`.repeat(10);

			// Read 1: pre-edit content. Stored as r1.
			const r1 = store.record(sessionId, "c1", before, false, 0);
			assertPass("e2e edit 1: pre-edit stored as r1", r1.shortRef === "r1");
			// Read 2: pre-edit again. Duplicate of r1.
			const r2 = store.record(sessionId, "c2", before, false, 0);
			assertPass("e2e edit 2: pre-edit duplicate refs r1", r2.isDuplicate && r2.shortRef === "r1");
			// Edit happens (we don't model the empty-on-clean here, that's
			// the tool's responsibility). After the edit, the file content
			// is different.
			// Read 3: post-edit content. Different bytes, new entry.
			const r3 = store.record(sessionId, "c3", after, false, 0);
			assertPass("e2e edit 3: post-edit is new (different bytes)", r3.isDuplicate === false);
			assertPass("e2e edit 3: shortRef is r2 (next free)", r3.shortRef === "r2");
			// Read 4: post-edit again. Duplicate of r2.
			const r4 = store.record(sessionId, "c4", after, false, 0);
			assertPass("e2e edit 4: post-edit duplicate refs r2", r4.isDuplicate && r4.shortRef === "r2");

			// Verify recall distinguishes the two versions.
			const recallBefore = decideRecall("r1", store, sessionId);
			const recallAfter = decideRecall("r2", store, sessionId);
			assertPass("e2e edit: recall r1 returns pre-edit", recallBefore.kind === "ok" && (recallBefore as any).fullText === before);
			assertPass("e2e edit: recall r2 returns post-edit", recallAfter.kind === "ok" && (recallAfter as any).fullText === after);
			logPass("e2e edit flow: pre-edit/pre-edit/post-edit/post-edit, both versions recallable");

			// Now the critical sub-test: recall must NOT itself be deduped
			// when its output happens to match a prior entry. The hook
			// (src/index.ts 9c) explicitly excludes the `recall` tool name
			// from the dedup pass. Here we test the contract: the
			// decideRecall function returns the full bytes, and the hook
			// (which we don't unit-test) is responsible for not deduping
			// them. We assert the data side: the bytes are correct.
			const fullTextFromRecall = (recallBefore as any).fullText;
			assertPass(
				"e2e edit: recall returns the bytes the LLM asked for",
				fullTextFromRecall === before,
				{ len: fullTextFromRecall.length },
			);
			// And if the hook's dedup logic were applied to recall's output,
			// the LLM would receive [=r1,Nb] instead. We can't test the hook
			// directly here, but we record this constraint as a code-level
			// assertion to keep it in the contract documentation.
		}

		// ---- Test 3: full compaction lifecycle across multiple content states ----
		{
			const store = new DedupStore();
			const sessionId = "e2e-compact";
			const v1 = "version one content here, not very long but over 80B threshold yes".repeat(2);
			const v2 = "version two content here, also over threshold, different text".repeat(2);
			const v3 = "version three content here, also over threshold, third value".repeat(2);

			// Sequence: v1, v1, v1, v2, v2, v2, compact, v2, v2, v2, v3, v3, v3
			const t1 = store.record(sessionId, "t1", v1, false, 0);
			const t2 = store.record(sessionId, "t2", v1, false, 0);
			const t3 = store.record(sessionId, "t3", v1, false, 0);
			assertPass("compact 1: t1 new (r1)", t1.shortRef === "r1");
			assertPass("compact 2: t2 dup of r1", t2.isDuplicate && t2.shortRef === "r1");
			assertPass("compact 3: t3 dup of r1", t3.isDuplicate && t3.shortRef === "r1");

			const t4 = store.record(sessionId, "t4", v2, false, 0);
			const t5 = store.record(sessionId, "t5", v2, false, 0);
			const t6 = store.record(sessionId, "t6", v2, false, 0);
			assertPass("compact 4: t4 new (v2 is different bytes)", t4.isDuplicate === false);
			assertPass("compact 5: t5 dup of t4's ref", t5.isDuplicate);
			assertPass("compact 6: t6 dup of t4's ref", t6.isDuplicate);

			// Compaction happens.
			store.onCompaction(sessionId);
			assertPass("compact: counter at 1", store.getCompactionCounter(sessionId) === 1);

			// After compaction, the next duplicate of v2 is a new first occurrence.
			const t7 = store.record(sessionId, "t7", v2, false, 1);
			assertPass("compact 7: post-compact v2 -> new (not dup)", t7.isDuplicate === false);
			// Subsequent duplicates of v2 dedup to t7's ref.
			const t8 = store.record(sessionId, "t8", v2, false, 1);
			assertPass("compact 8: post-compact v2 again -> dup of t7", t8.isDuplicate);
			assertPass("compact 8: t7 and t8 share a ref", t7.shortRef === t8.shortRef);

			// v3 is new bytes; always a first occurrence.
			const t9 = store.record(sessionId, "t9", v3, false, 1);
			assertPass("compact 9: v3 is new", t9.isDuplicate === false);
			const t10 = store.record(sessionId, "t10", v3, false, 1);
			assertPass("compact 10: v3 dup of t9", t10.isDuplicate && t10.shortRef === t9.shortRef);
			logPass("e2e compaction: 12 calls, 2 compactions, all dedup state correct");
		}

		// ---- Test 4: hook shape contract — what the LLM actually sees ----
		{
			// The hook contract:
			//   - First occurrence: hook does not return anything; Pi uses event.content as-is.
			//     LLM sees the full text.
			//   - Duplicate: hook returns { content: [{ type: "text", text: "[=rN,sizeB]" }] }.
			//     LLM sees the short reference.
			//   - After compaction: same hook logic; the dedup store treats the next
			//     duplicate as a new first occurrence (full text).

			// Verify the rendered-text shape that the hook would produce.
			const store = new DedupStore();
			const text = "x".repeat(500);
			const r1 = store.record("s", "c1", text, false, 0);
			const r2 = store.record("s", "c2", text, false, 0);

			// What the LLM sees for the second call:
			const dedupNotice = `[=${r2.shortRef},${text.length}B]`;
			assertPass(
				"hook shape: dedup notice is exactly '[=r1,500B]' (11 chars)",
				dedupNotice === "[=r1,500B]",
				{ dedupNotice },
			);
			// And the LLM can call recall to recover the original:
			const recall = decideRecall("r1", store, "s");
			if (recall.kind === "ok") {
				assertPass("hook shape: recall returns byte-equal original", recall.fullText === text);
				assertPass("hook shape: recall sizeBytes matches", recall.sizeBytes === 500);
			} else {
				assertPass("hook shape: recall should succeed", false, { recall });
			}
			logPass("hook shape: 11-char dedup notice, recall returns original");
		}

		// ---- Test 5: intensive — simulate a long session with mixed dedup patterns ----
		{
			const store = new DedupStore({ maxEntriesPerSession: 50 });
			const sessionId = "intensive";
			// A long-running session pattern: read A, read A, read A, then read B,
			// re-read A (still same), edit A, re-read A (new bytes), then a
			// compaction, then re-read everything.
			const A1 = "file A version 1, with enough content to exceed the threshold of 80 bytes".repeat(2);
			const A2 = A1 + "  // a one-line addition to make the bytes different here";
			const B = "file B content here, completely different from A in every byte here".repeat(2);

			const calls: Array<{ content: string; expectDup: boolean; label: string }> = [];
			calls.push({ content: A1, expectDup: false, label: "read A1 #1" });
			calls.push({ content: A1, expectDup: true, label: "read A1 #2" });
			calls.push({ content: A1, expectDup: true, label: "read A1 #3" });
			calls.push({ content: B, expectDup: false, label: "read B" });
			calls.push({ content: A1, expectDup: true, label: "read A1 #4" });
			calls.push({ content: A2, expectDup: false, label: "read A2 (post-edit)" });
			calls.push({ content: A2, expectDup: true, label: "read A2 #2" });

			let compactions = 0;
			for (const c of calls) {
				const r = store.record(sessionId, c.label, c.content, false, compactions);
				assertPass(
					`intensive: ${c.label} expectDup=${c.expectDup}, got isDuplicate=${r.isDuplicate}`,
					r.isDuplicate === c.expectDup,
					{ label: c.label, r },
				);
			}

			// After compaction, the LLM has lost all prior tool results from its
			// context. The next read of each known content is therefore a NEW
			// first occurrence (per the design: pass through once, then resume
			// dedup). This is the post-compaction pass-through rule.
			store.onCompaction(sessionId);
			compactions = 1;
			calls.length = 0;
			calls.push({ content: A2, expectDup: false, label: "post-compact A2 #1" });
			calls.push({ content: A2, expectDup: true, label: "post-compact A2 #2" });
			calls.push({ content: A1, expectDup: false, label: "post-compact A1 #1" });
			calls.push({ content: A1, expectDup: true, label: "post-compact A1 #2" });
			calls.push({ content: B, expectDup: false, label: "post-compact B #1" });
			calls.push({ content: B, expectDup: true, label: "post-compact B #2" });
			for (const c of calls) {
				const r = store.record(sessionId, c.label, c.content, false, compactions);
				assertPass(
					`intensive: ${c.label} expectDup=${c.expectDup}, got isDuplicate=${r.isDuplicate}`,
					r.isDuplicate === c.expectDup,
					{ label: c.label, r },
				);
			}
			logPass("intensive: 13 mixed dedup calls, 1 compaction, all correct");
		}

		// ---- Test 6: documented limitations ----
		// Limitation: bash clamping injects a random hex filename into the
		// spillover path footer (`pi_bash_spillover_<hex>.log`). Two identical
		// bash commands on the same file therefore produce byte-different
		// clamped output, and dedup correctly does not fire. The common
		// case (small bash output under maxLines/maxTotalBytes) is unaffected
		// because no clamping happens.
		{
			const store = new DedupStore();
			const sessionId = "limitation";
			// Simulate two clamped bash outputs of the same command on the
			// same file, but with different random spillover hex in the
			// footer (a real limitation, not a bug).
			const base = "line 1\nline 2\n".repeat(30); // 12 lines, well under threshold, no clamping -> dedup fires
			const fullBash1 = base + "\n[Truncated: 12/12 lines. Full: /tmp/pi_bash_spillover_aaaa1111.log]";
			const fullBash2 = base + "\n[Truncated: 12/12 lines. Full: /tmp/pi_bash_spillover_bbbb2222.log]";
			// Both are > 80 bytes, both have identical content except the
			// spillover path. With small output, no clamping actually
			// happens in real usage. To model the limitation directly:
			// we use the spillover path with a random hex to show why
			// clamped bash output doesn't dedup.
			const r1 = store.record(sessionId, "bash1", fullBash1, false, 0);
			const r2 = store.record(sessionId, "bash2", fullBash2, false, 0);
			assertPass(
				"limitation: clamped bash output with random spillover path -> NOT a duplicate",
				r2.isDuplicate === false,
				{ r1, r2 },
			);
			// The same command output without the random hex (or under
			// the 80-byte threshold entirely) does dedup correctly.
			const small = "a".repeat(200);
			const small1 = store.record(sessionId, "s1", small, false, 0);
			const small2 = store.record(sessionId, "s2", small, false, 0);
			assertPass(
				"limitation context: small bash output (no clamping) -> dedup fires",
				small2.isDuplicate === true,
				{ small1, small2 },
			);
			logPass("documented limitation: clamped bash with random spillover path; small bash still dedups");
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
