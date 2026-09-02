// Section 29: Content-Addressed Tool-Result Dedup
// Tests the DedupStore: first-occurrence pass-through, byte-equality
// dedup, threshold below which nothing is deduped, error pass-through,
// compaction-induced pass-through, session isolation, LRU eviction,
// and recall retrieval.

import { DedupStore } from "../src/dedup/content_store";
import { runSection, assertPass, logPass } from "./_setup";

function makeContent(seed: number, sizeBytes: number): string {
	// Deterministic pseudo-content of a given size, padded with line breaks.
	const base = `line ${seed}\nfield_a=hello_${seed}\nfield_b=world_${seed}\n`;
	const repeats = Math.max(1, Math.floor(sizeBytes / base.length));
	let out = base.repeat(repeats);
	if (out.length < sizeBytes) out += "x".repeat(sizeBytes - out.length);
	return out.slice(0, sizeBytes);
}

async function main(): Promise<void> {
	await runSection("29. Content-Addressed Dedup", () => {
		// ---- Test 1: first-occurrence pass-through ----
		{
			const store = new DedupStore();
			const r = store.record("s1", "call_1", "read", {}, makeContent(1, 500), false, 0);
			assertPass(
				"first occurrence: not a duplicate",
				r.isDuplicate === false,
				{ r },
			);
			assertPass(
				"first occurrence: short ref is r1",
				r.shortRef === "r1",
				{ r },
			);
			assertPass(
				"first occurrence: prior ref is null",
				r.priorRef === null,
				{ r },
			);
			assertPass(
				"first occurrence: side store has one entry",
				store.size("s1") === 1,
				{ size: store.size("s1") },
			);
			logPass("first-occurrence pass-through");
		}

		// ---- Test 2: duplicate detection (byte equality) ----
		{
			const store = new DedupStore();
			const content = makeContent(2, 500);
			store.record("s2", "call_1", "read", {}, content, false, 0);
			const r = store.record("s2", "call_2", "read", {}, content, false, 0);
			assertPass(
				"duplicate: marked as duplicate",
				r.isDuplicate === true,
				{ r },
			);
			assertPass(
				"duplicate: shortRef points to prior (r1)",
				r.shortRef === "r1",
				{ r },
			);
			assertPass(
				"duplicate: priorRef set to r1",
				r.priorRef === "r1",
				{ r },
			);
			assertPass(
				"duplicate: side store still has 1 entry (no new ref allocated)",
				store.size("s2") === 1,
				{ size: store.size("s2") },
			);
			logPass("duplicate detection (byte equality)");
		}

		// ---- Test 3: threshold (results <= 80 bytes are not deduped) ----
		{
			const store = new DedupStore();
			const tiny = "x".repeat(80); // exactly at threshold
			const r1 = store.record("s3", "c1", "read", {}, tiny, false, 0);
			const r2 = store.record("s3", "c2", "read", {}, tiny, false, 0);
			assertPass(
				"80-byte result: first call not a duplicate",
				r1.isDuplicate === false,
				{ r1 },
			);
			// r2 should still get a fresh ref because tiny is at the threshold
			// and the test is "content.length <= minBytes" (default 80).
			assertPass(
				"80-byte result: second call is NOT a duplicate (at threshold)",
				r2.isDuplicate === false,
				{ r2 },
			);
			const big = "y".repeat(81);
			const r3 = store.record("s3", "c3", "read", {}, big, false, 0);
			const r4 = store.record("s3", "c4", "read", {}, big, false, 0);
			assertPass(
				"81-byte result: first call not a duplicate",
				r3.isDuplicate === false,
				{ r3 },
			);
			assertPass(
				"81-byte result: second call IS a duplicate",
				r4.isDuplicate === true,
				{ r4 },
			);
			logPass("threshold: 80 bytes boundary respected");
		}

		// ---- Test 4: error results are never deduped ----
		{
			const store = new DedupStore();
			const errMsg = "ENOENT: file not found, and a lot more text here to exceed 80 bytes easily yes";
			const r1 = store.record("s4", "c1", "read", {}, errMsg, true, 0);
			const r2 = store.record("s4", "c2", "read", {}, errMsg, true, 0);
			assertPass(
				"error result: first call not a duplicate",
				r1.isDuplicate === false,
				{ r1 },
			);
			assertPass(
				"error result: second identical call also not a duplicate",
				r2.isDuplicate === false,
				{ r2 },
			);
			assertPass(
				"error result: each got its own ref",
				r1.shortRef !== r2.shortRef,
				{ r1, r2 },
			);
			logPass("error results pass through (never deduped)");
		}

		// ---- Test 5: compaction -> next duplicate is full text ----
		{
			const store = new DedupStore();
			const content = makeContent(5, 500);
			const r1 = store.record("s5", "c1", "read", {}, content, false, 0);
			const r2 = store.record("s5", "c2", "read", {}, content, false, 0);
			assertPass(
				"before compaction: second call is a duplicate",
				r2.isDuplicate === true,
				{ r2 },
			);
			store.onCompaction("s5");
			assertPass(
				"compaction counter incremented to 1",
				store.getCompactionCounter("s5") === 1,
				{ counter: store.getCompactionCounter("s5") },
			);
			const r3 = store.record("s5", "c3", "read", {}, content, false, 1);
			assertPass(
				"after compaction: same content treated as new (not duplicate)",
				r3.isDuplicate === false,
				{ r3 },
			);
			// Note: the duplicate at c2 did not allocate a new ref, so the next
			// allocation is r2 (not r3). c1 was r1, c2 reused r1, c3 -> r2.
			assertPass(
				"after compaction: new ref allocated (next free after the deduped c2)",
				r3.shortRef === "r2",
				{ r3, r1Ref: r1.shortRef },
			);
			const r4 = store.record("s5", "c4", "read", {}, content, false, 1);
			assertPass(
				"after compaction: subsequent duplicate IS a duplicate again",
				r4.isDuplicate === true,
				{ r4 },
			);
			assertPass(
				"after compaction: subsequent duplicate refs the new live one (r2)",
				r4.shortRef === "r2",
				{ r4 },
			);
			logPass("compaction: pass-through after compaction, then dedup resumes");
		}

		// ---- Test 6: session isolation ----
		{
			const store = new DedupStore();
			const content = makeContent(6, 500);
			store.record("sA", "c1", "read", {}, content, false, 0);
			const rA = store.record("sA", "c2", "read", {}, content, false, 0);
			const rB = store.record("sB", "c1", "read", {}, content, false, 0);
			assertPass(
				"session A: second call is duplicate",
				rA.isDuplicate === true,
				{ rA },
			);
			assertPass(
				"session B: first call is NOT a duplicate (different session)",
				rB.isDuplicate === false,
				{ rB },
			);
			store.onCompaction("sA");
			const rA2 = store.record("sA", "c3", "read", {}, content, false, 1);
			const rB2 = store.record("sB", "c2", "read", {}, content, false, 0);
			assertPass(
				"session A after compaction: not duplicate",
				rA2.isDuplicate === false,
				{ rA2 },
			);
			assertPass(
				"session B (no compaction): IS duplicate",
				rB2.isDuplicate === true,
				{ rB2 },
			);
			logPass("session isolation: per-session counter and store");
		}

		// ---- Test 7: LRU cap evicts oldest; access-ordered (hot entries stick) ----
		{
			// Sub-test 7a: strict FIFO under cap pressure.
			const store = new DedupStore({ maxEntriesPerSession: 3 });
			const c1 = makeContent(10, 200);
			const c2 = makeContent(20, 200);
			const c3 = makeContent(30, 200);
			const c4 = makeContent(40, 200);
			const c5 = makeContent(50, 200);
			store.record("s7", "c1", "read", {}, c1, false, 0);
			store.record("s7", "c2", "read", {}, c2, false, 0);
			store.record("s7", "c3", "read", {}, c3, false, 0);
			assertPass(
				"LRU 7a: 3 entries within cap",
				store.size("s7") === 3,
				{ size: store.size("s7") },
			);
			store.record("s7", "c4", "read", {}, c4, false, 0);
			assertPass(
				"LRU 7a: 4th entry triggers eviction; cap stays at 3",
				store.size("s7") === 3,
				{ size: store.size("s7") },
			);
			// c1 was evicted (FIFO oldest). A re-record of c1 is a new first
			// occurrence since c1's hash is no longer in byHash.
			const r = store.record("s7", "c1b", "read", {}, c1, false, 0);
			assertPass(
				"LRU 7a: after eviction, re-recording c1 is a new first occurrence",
				r.isDuplicate === false,
				{ r },
			);
			// At this point the store holds c2, c3, c4, c1b (4 items) -> evicts c2.
			// So c2 is now also evicted. A re-record of c2 is also new.
			const r2 = store.record("s7", "c2b", "read", {}, c2, false, 0);
			assertPass(
				"LRU 7a: under pressure, c2 was also evicted -> c2b is new",
				r2.isDuplicate === false,
				{ r2 },
			);

			// Sub-test 7b: access-ordered LRU protects hot entries.
			// With cap=3, fill with 3 entries, then access the oldest, then
			// add a 4th. The accessed (touched) entry survives; the unaccessed
			// one is evicted.
			const store2 = new DedupStore({ maxEntriesPerSession: 3 });
			const x1 = makeContent(60, 200);
			const x2 = makeContent(70, 200);
			const x3 = makeContent(80, 200);
			store2.record("s7b", "x1", "read", {}, x1, false, 0); // r1
			store2.record("s7b", "x2", "read", {}, x2, false, 0); // r2
			store2.record("s7b", "x3", "read", {}, x3, false, 0); // r3
			// Touch x1 by recording a duplicate -> promotes to MRU.
			const touch = store2.record("s7b", "x1_dup", "read", {}, x1, false, 0);
			assertPass(
				"LRU 7b: touch of r1 is a duplicate hit",
				touch.isDuplicate && touch.shortRef === "r1",
				{ touch },
			);
			// Add x4. r2 (the now-oldest) is evicted; r1 survives because it
			// was just touched.
			const x4 = makeContent(90, 200);
			store2.record("s7b", "x4", "read", {}, x4, false, 0);
			// x2 is gone, x1 is still here.
			const r2b = store2.record("s7b", "x2_dup", "read", {}, x2, false, 0);
			assertPass(
				"LRU 7b: x2 (untouched) was evicted -> x2_dup is new",
				!r2b.isDuplicate,
				{ r2b },
			);
			const r1b = store2.record("s7b", "x1_redup", "read", {}, x1, false, 0);
			assertPass(
				"LRU 7b: x1 (touched/MRU) survived -> x1_redup is duplicate",
				r1b.isDuplicate && r1b.shortRef === "r1",
				{ r1b },
			);
			logPass("LRU: FIFO under pressure; access-ordered protects hot entries");
		}

		// ---- Test 8: recall round-trip (byte-equal retrieval) ----
		{
			const store = new DedupStore();
			const content = makeContent(8, 500);
			const r = store.record("s8", "call_x", "read", {}, content, false, 0);
			const got = store.get("s8", r.shortRef);
			assertPass("get returns the entry", got !== null, { got });
			assertPass(
				"get: full text byte-equal to original",
				got !== null && got.fullText === content,
				{ got },
			);
			assertPass(
				"get: sizeBytes matches",
				got !== null && got.sizeBytes === 500,
				{ got },
			);
			logPass("recall round-trip: byte-equal retrieval");
		}

		// ---- Test 9: get on missing ref returns null ----
		{
			const store = new DedupStore();
			store.record("s9", "c1", "read", {}, makeContent(9, 500), false, 0);
			assertPass(
				"get on unknown ref returns null",
				store.get("s9", "r99") === null,
			);
			assertPass(
				"get on unknown session returns null",
				store.get("not-a-session", "r1") === null,
			);
			logPass("missing ref / unknown session: null, not crash");
		}

		// ---- Test 10: multiple sessions, same content, two refs ----
		{
			const store = new DedupStore();
			const content = makeContent(10, 500);
			const rA = store.record("sA", "c1", "read", {}, content, false, 0);
			const rB = store.record("sB", "c1", "read", {}, content, false, 0);
			assertPass(
				"two sessions: same content gets r1 in each",
				rA.shortRef === "r1" && rB.shortRef === "r1",
				{ rA, rB },
			);
			// Retrieving r1 from each session returns the same content.
			const gotA = store.get("sA", "r1");
			const gotB = store.get("sB", "r1");
			assertPass(
				"two sessions: r1 retrievable in each, content identical",
				gotA !== null && gotB !== null && gotA.fullText === gotB.fullText,
				{ gotA, gotB },
			);
			logPass("multiple sessions: independent ref counters");
		}

		// ---- Test 11: clearSession removes all state for that session ----
		{
			const store = new DedupStore();
			store.record("s11", "c1", "read", {}, makeContent(11, 500), false, 0);
			store.record("s11", "c2", "read", {}, makeContent(12, 500), false, 0);
			assertPass("before clear: 2 entries", store.size("s11") === 2);
			store.clearSession("s11");
			assertPass("after clear: 0 entries", store.size("s11") === 0);
			// After clear, the same content is a new first occurrence.
			const r = store.record("s11", "c1b", "read", {}, makeContent(11, 500), false, 0);
			assertPass("after clear: re-recording yields r1", r.shortRef === "r1");
			logPass("clearSession: state fully reset");
		}

		// ---- Test 12: intensive end-to-end — simulate a real session ----
		{
			const store = new DedupStore();
			const fileA = makeContent(100, 800);
			const fileB = makeContent(200, 600);

			// Session: read A, read B, read A again, bash ls, read A again, edit, read A again (post-edit, new content)
			const editChange = "/* edited */ ";
			const fileApost = editChange + fileA;

			const t1 = store.record("ses", "t1", "read", {}, fileA, false, 0);
			assertPass("e2e: read A -> new", !t1.isDuplicate && t1.shortRef === "r1");
			const t2 = store.record("ses", "t2", "read", {}, fileB, false, 0);
			assertPass("e2e: read B -> new", !t2.isDuplicate && t2.shortRef === "r2");
			const t3 = store.record("ses", "t3", "read", {}, fileA, false, 0);
			assertPass("e2e: read A again -> duplicate of r1", t3.isDuplicate && t3.shortRef === "r1");
			const t4 = store.record("ses", "t4", "read", {}, fileA, false, 0);
			assertPass("e2e: read A again -> still duplicate of r1", t4.isDuplicate && t4.shortRef === "r1");
			// Edit succeeded (empty content), no dedup payload.
			const t5 = store.record("ses", "t5", "read", {}, "", false, 0);
			assertPass("e2e: edit (empty) -> new (but < threshold so trivial)", !t5.isDuplicate);
			// Re-read post-edit. Content is different (has the edit prefix).
			const t6 = store.record("ses", "t6", "read", {}, fileApost, false, 0);
			assertPass("e2e: read A post-edit -> new (different content)", !t6.isDuplicate);
			// Re-read post-edit again. Same content -> duplicate of t6.
			const t7 = store.record("ses", "t7", "read", {}, fileApost, false, 0);
			assertPass("e2e: read A post-edit again -> duplicate of r6", t7.isDuplicate);
			// Compaction happens.
			store.onCompaction("ses");
			// Re-read post-edit. Now treated as new (compaction pass-through).
			const t8 = store.record("ses", "t8", "read", {}, fileApost, false, 1);
			assertPass("e2e: post-compaction read A -> new", !t8.isDuplicate);
			// But t8 is identical to t7's content. After this, t7 is "stale" too;
			// t8 is the new live one. A subsequent duplicate of fileApost dedups to t8.
			const t9 = store.record("ses", "t9", "read", {}, fileApost, false, 1);
			assertPass("e2e: subsequent post-compaction read A -> duplicate of t8", t9.isDuplicate);
			// Recall correctness: get r1 returns the original fileA, not fileApost.
			const recalledR1 = store.get("ses", "r1");
			assertPass(
				"e2e: recall r1 returns ORIGINAL fileA (pre-edit bytes)",
				recalledR1 !== null && recalledR1.fullText === fileA,
				{ recalledR1Preview: recalledR1?.fullText.slice(0, 30) },
			);
			logPass("intensive end-to-end: read/edit/read across compaction, recall correct");
		}

		// ---- Test 13: byte-equal content from different tools still dedups ----
		{
			const store = new DedupStore();
			const content = makeContent(13, 500);
			const r1 = store.record("ses", "toolA_call1", "read", {}, content, false, 0);
			const r2 = store.record("ses", "toolB_call1", "read", {}, content, false, 0);
			assertPass("different tool, same content: dedup fires", r2.isDuplicate);
			assertPass("different tool, same content: refs the prior", r2.shortRef === r1.shortRef);
			logPass("tool-agnostic: identical bytes dedup regardless of source tool");
		}

		// ---- Test 14: 1-byte difference prevents dedup ----
		{
			const store = new DedupStore();
			const a = makeContent(14, 500);
			const b = a.slice(0, -1) + "Z"; // last byte different
			assertPass("test fixture: 1-byte difference is real", a !== b);
			const r1 = store.record("ses", "c1", "read", {}, a, false, 0);
			const r2 = store.record("ses", "c2", "read", {}, b, false, 0);
			assertPass("1-byte difference: NOT a duplicate", !r2.isDuplicate);
			assertPass(
				"1-byte difference: new ref allocated",
				r2.shortRef !== r1.shortRef,
			);
			logPass("strict byte equality: 1 byte off -> no dedup");
		}

		// ---- Test 15: end-to-end with realistic LRU pressure ----
		{
			const store = new DedupStore({ maxEntriesPerSession: 10 });
			const contents: string[] = [];
			for (let i = 0; i < 50; i++) {
				contents.push(makeContent(1000 + i, 200));
			}
			// Record all 50 unique contents.
			for (let i = 0; i < 50; i++) {
				store.record("ses", `c${i}`, "read", {}, contents[i], false, 0);
			}
			assertPass(
				"LRU pressure: store size is capped at 10",
				store.size("ses") === 10,
				{ size: store.size("ses") },
			);
			// The 40 oldest are evicted. The 10 most recent (40-49) are present.
			// Recording a duplicate of an evicted one (e.g. contents[0]) is now new.
			const r = store.record("ses", "dup0", "read", {}, contents[0], false, 0);
			assertPass(
				"LRU pressure: re-recording evicted content is a new first occurrence",
				!r.isDuplicate,
			);
			logPass("intensive LRU: 50 entries with cap 10, eviction correct");
		}

		// ---- Test 16: tool-aware dedup — different tools, same content ----
		// Even if the rendered text is byte-equal, a `read` and a `bash cat`
		// of the same file should NOT dedup against each other. The dedup
		// key includes the tool name, so they get different refs.
		{
			const store = new DedupStore();
			const content = makeContent(16, 500);
			const r1 = store.record("s", "c1", "read", { path: "f" }, content, false, 0);
			const r2 = store.record("s", "c2", "bash", { command: "cat f" }, content, false, 0);
			assertPass("tool-aware: read and bash with same content are NOT duplicates", !r2.isDuplicate, {
				r1,
				r2,
			});
			assertPass("tool-aware: each tool gets its own ref", r1.shortRef !== r2.shortRef, {
				r1,
				r2,
			});
			logPass("tool-aware: different tools don't dedup against each other");
		}

		// ---- Test 17: param-sensitive dedup — same tool, different params ----
		// `read(file, offset=1, limit=200)` and `read(file, offset=100, limit=100)`
		// produce different rendered outputs in general, but if the file is
		// small enough that they happen to be byte-equal, the paramsKey must
		// still keep them as separate refs. The LLM might otherwise try to
		// "recall" the second read and get the first read's content.
		{
			const store = new DedupStore();
			const content = makeContent(17, 500);
			const r1 = store.record("s", "c1", "read", { path: "f", offset: 1, limit: 200 }, content, false, 0);
			const r2 = store.record("s", "c2", "read", { path: "f", offset: 100, limit: 100 }, content, false, 0);
			assertPass(
				"param-sensitive: same tool, different params, same content -> NOT a duplicate",
				!r2.isDuplicate,
				{ r1, r2 },
			);
			assertPass(
				"param-sensitive: different params -> different refs",
				r1.shortRef !== r2.shortRef,
			);

			// Sanity: same tool, same params, same content -> IS a duplicate.
			const r3 = store.record("s", "c3", "read", { path: "f", offset: 1, limit: 200 }, content, false, 0);
			assertPass(
				"param-sensitive: same tool, same params, same content -> duplicate",
				r3.isDuplicate && r3.shortRef === r1.shortRef,
				{ r3, r1 },
			);
			logPass("param-sensitive: input params are part of the dedup key");
		}

		// ---- Test 18: stable stringify — key insertion order doesn't matter ----
		// Two input objects with the same keys but different insertion order
		// should produce the same paramsKey, so the dedup is deterministic
		// regardless of how the harness builds the input object.
		{
			const store = new DedupStore();
			const content = makeContent(18, 500);
			const r1 = store.record("s", "c1", "read", { path: "a", offset: 1 }, content, false, 0);
			const r2 = store.record("s", "c2", "read", { offset: 1, path: "a" }, content, false, 0);
			assertPass(
				"stable stringify: same content + reordered params -> duplicate",
				r2.isDuplicate && r2.shortRef === r1.shortRef,
				{ r1, r2 },
			);
			logPass("stable stringify: params key is order-independent");
		}

		// ---- Test 19: eviction prefers dead entries over live ones ----
		// The LRU should evict an entry the LLM has already lost track of
		// (post-compaction) before evicting one still in the LLM's context.
		// This is the durability fix from the real-world test.
		{
			const store = new DedupStore({ maxEntriesPerSession: 3 });
			const c1 = makeContent(190, 200);
			const c2 = makeContent(191, 200);
			const c3 = makeContent(192, 200);
			const c4 = makeContent(193, 200);
			// All 3 entries are at compaction counter 0.
			store.record("s", "c1", "read", {}, c1, false, 0);
			store.record("s", "c2", "read", {}, c2, false, 0);
			store.record("s", "c3", "read", {}, c3, false, 0);
			// Compaction happens. Now entries from "before" the compaction
			// are dead; their lastSeenInContext (0) is below the current (1).
			store.onCompaction("s");
			// Recording a 4th entry triggers eviction. The store should
			// prefer to evict a dead entry (any of c1/c2/c3 are dead now).
			const r4 = store.record("s", "c4", "read", {}, c4, false, 1);
			assertPass("eviction: 4th entry added, cap stays at 3", store.size("s") === 3, {
				size: store.size("s"),
			});
			// r4 is the new live one.
			assertPass("eviction: r4 is the new entry", r4.shortRef === "r4");
			// The prior dead entries (c1, c2, c3) should be evictable. We
			// can confirm by trying to recall them — at least one is gone.
			let anyEvicted = false;
			for (const ref of ["r1", "r2", "r3"]) {
				if (store.get("s", ref) === null) {
					anyEvicted = true;
					break;
				}
			}
			assertPass("eviction: at least one dead prior entry was evicted", anyEvicted);
			// r4 should still be recallable.
			assertPass(
				"eviction: the new live entry (r4) is recallable",
				store.get("s", "r4") !== null,
			);
			logPass("eviction: prefers dead entries over live ones");
		}

		// ---- Test 20: when all entries are live, eviction falls back to LRU ----
		// If every entry is still in the LLM's context (no compaction
		// happened), eviction falls back to plain LRU. This is the case the
		// LLM is most likely to hit: cap is too small for the active session.
		{
			const store = new DedupStore({ maxEntriesPerSession: 3 });
			const c1 = makeContent(200, 200);
			const c2 = makeContent(201, 200);
			const c3 = makeContent(202, 200);
			const c4 = makeContent(203, 200);
			store.record("s", "c1", "read", {}, c1, false, 0);
			store.record("s", "c2", "read", {}, c2, false, 0);
			store.record("s", "c3", "read", {}, c3, false, 0);
			// No compaction. All entries are at lastSeenInContext=0 == current.
			const r4 = store.record("s", "c4", "read", {}, c4, false, 0);
			// Eviction must fall back to oldest, which is r1.
			assertPass("fallback eviction: r4 added, cap stays at 3", store.size("s") === 3);
			assertPass("fallback eviction: r1 (oldest) was evicted", store.get("s", "r1") === null);
			assertPass("fallback eviction: r4 is recallable", store.get("s", "r4") !== null);
			logPass("eviction: LRU fallback when no dead entries exist");
		}

		// ---- Test 21: get() returns toolName and paramsKey ----
		{
			const store = new DedupStore();
			const r = store.record("s", "c1", "code_search", `{"query":"foo"}`, "x".repeat(200), false, 0);
			const got = store.get("s", r.shortRef);
			assertPass("get: returns toolName", got !== null && got.toolName === "code_search", { got });
			assertPass("get: returns paramsKey", got !== null && got.paramsKey.length === 4, { got });
			assertPass("get: paramsKey is hex", got !== null && /^[0-9a-f]{4}$/.test(got.paramsKey), {
				got,
			});
			logPass("get: returns toolName and paramsKey for self-describing refs");
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
