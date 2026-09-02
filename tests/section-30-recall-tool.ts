// Section 30: Recall Tool Decision Logic
// Tests the pure `decideRecall` function: validation, retrieval, errors.
// No Pi harness required — the tool is exercised via the pure function.

import { decideRecall } from "../src/dedup/recall_tool";
import { DedupStore } from "../src/dedup/content_store";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("30. Recall Tool Decision Logic", () => {
		// ---- Test 1: valid ref returns full text ----
		{
			const store = new DedupStore();
			const content = "line 1\nline 2\nline 3\n".repeat(20); // >80B
			const r = store.record("s1", "c1", "read", {}, content, false, 0);
			const decision = decideRecall(r.shortRef, store, "s1");
			assertPass("valid ref: kind is ok", decision.kind === "ok", { decision });
			if (decision.kind === "ok") {
				assertPass(
					"valid ref: fullText byte-equal to original",
					decision.fullText === content,
					{ len: decision.fullText.length },
				);
				assertPass(
					"valid ref: sizeBytes matches",
					decision.sizeBytes === content.length,
				);
			}
			logPass("valid ref: full text returned");
		}

		// ---- Test 2: empty ref -> error ----
		{
			const store = new DedupStore();
			const decision = decideRecall("", store, "s1");
			assertPass("empty ref: kind is error", decision.kind === "error");
			if (decision.kind === "error") {
				assertPass(
					"empty ref: message mentions 'required'",
					decision.message.toLowerCase().includes("required"),
					{ msg: decision.message },
				);
			}
			const ws = decideRecall("   ", store, "s1");
			assertPass("whitespace-only ref: also error", ws.kind === "error");
			const undef = decideRecall(undefined, store, "s1");
			assertPass("undefined ref: error (not crash)", undef.kind === "error");
			logPass("empty/whitespace/undefined ref: error, not crash");
		}

		// ---- Test 3: invalid format -> error ----
		// Note: refs with leading/trailing whitespace are trimmed first and
		// then validated, so "r1 " is treated as "r1" (and would succeed if
		// the store had r1; otherwise it returns "no content", not "invalid").
		{
			const store = new DedupStore();
			const cases = ["abc", "r", "r-1", "R1", "1", "r1.0", "rr1"];
			for (const c of cases) {
				const d = decideRecall(c, store, "s1");
				assertPass(
					`invalid format '${c}': error`,
					d.kind === "error",
					{ c, d },
				);
				if (d.kind === "error") {
					assertPass(
						`invalid format '${c}': message mentions 'invalid' or format`,
						d.message.toLowerCase().includes("invalid") ||
							d.message.toLowerCase().includes("expected format"),
						{ msg: d.message },
					);
				}
			}
			// Whitespace-padded valid format: trim, then succeed-or-no-content.
			const padded = decideRecall("  r1  ", store, "s1");
			assertPass(
				"padded '  r1  ' trims to r1; store has no r1 -> 'no content' error",
				padded.kind === "error" && padded.message.includes("no content"),
				{ padded },
			);
			logPass("invalid format: rejected with clear message; whitespace is trimmed");
		}

		// ---- Test 4: unknown ref -> error ----
		{
			const store = new DedupStore();
			store.record("s1", "c1", "read", {}, "x".repeat(200), false, 0);
			const d = decideRecall("r99", store, "s1");
			assertPass("unknown ref: kind is error", d.kind === "error");
			if (d.kind === "error") {
				assertPass(
					"unknown ref: message names the ref",
					d.message.includes("r99"),
					{ msg: d.message },
				);
				assertPass(
					"unknown ref: message says 'no content' or similar",
					d.message.toLowerCase().includes("no content"),
					{ msg: d.message },
				);
			}
			logPass("unknown ref: clear error, doesn't crash");
		}

		// ---- Test 5: session isolation ----
		{
			const store = new DedupStore();
			store.record("sA", "c1", "read", {}, "alpha content here yes".repeat(10), false, 0);
			// sA has r1. sB has no entries.
			const inA = decideRecall("r1", store, "sA");
			assertPass("sA: r1 is retrievable", inA.kind === "ok");
			const inB = decideRecall("r1", store, "sB");
			assertPass("sB: r1 from sA is NOT retrievable", inB.kind === "error");
			logPass("session isolation: cross-session refs return error");
		}

		// ---- Test 6: bare text (no preamble) ----
		{
			const store = new DedupStore();
			const content = "the quick brown fox jumps over the lazy dog ".repeat(5);
			const r = store.record("s1", "c1", "read", {}, content, false, 0);
			const d = decideRecall(r.shortRef, store, "s1");
			if (d.kind !== "ok") {
				assertPass("expected ok result", false, { d });
				return;
			}
			assertPass(
				"bare text: fullText starts with content[0], not 'recall' or 'here'",
				d.fullText.startsWith("the quick brown"),
				{ preview: d.fullText.slice(0, 30) },
			);
			assertPass(
				"bare text: no leading newline",
				!d.fullText.startsWith("\n"),
				{ firstChars: d.fullText.slice(0, 5) },
			);
			logPass("bare text: no preamble, no leading whitespace");
		}

		// ---- Test 7: intensive — multiple refs, one missing in the middle ----
		{
			const store = new DedupStore();
			const c1 = "alpha ".repeat(30);
			const c2 = "beta ".repeat(30);
			const c3 = "gamma ".repeat(30);
			const r1 = store.record("s1", "x", "read", {}, c1, false, 0);
			store.record("s1", "y", "read", {}, c2, false, 0);
			store.record("s1", "z", "read", {}, c3, false, 0);
			assertPass("intensive: 3 entries stored", store.size("s1") === 3);
			const d1 = decideRecall(r1.shortRef, store, "s1");
			assertPass("intensive: r1 retrievable", d1.kind === "ok");
			const d2 = decideRecall("r2", store, "s1");
			assertPass("intensive: r2 retrievable", d2.kind === "ok");
			const d3 = decideRecall("r3", store, "s1");
			assertPass("intensive: r3 retrievable", d3.kind === "ok");
			const d4 = decideRecall("r4", store, "s1");
			assertPass("intensive: r4 unknown -> error", d4.kind === "error");
			logPass("intensive: multi-ref recall, mixed hit/miss");
		}

		// ---- Test 8: end-to-end through store + decide + content match ----
		{
			// Realistic: simulate two tool calls of the same content, then
			// recall on the dedup'd one.
			const store = new DedupStore();
			const fileContent = JSON.stringify({
				users: Array.from({ length: 30 }, (_, i) => ({ id: i, name: `user_${i}` })),
			});
			const r1 = store.record("s1", "read_x", "read", {}, fileContent, false, 0);
			const r2 = store.record("s1", "bash_cat_x", "read", {}, fileContent, false, 0);
			assertPass("e2e: first record is not duplicate", r1.isDuplicate === false);
			assertPass("e2e: second record IS duplicate", r2.isDuplicate === true);
			assertPass("e2e: dedup refs the prior", r2.shortRef === r1.shortRef);
			// The dedup'd r2 -> recall -> original content.
			const d = decideRecall(r2.shortRef, store, "s1");
			assertPass("e2e: recall on the dedup'd ref returns content", d.kind === "ok");
			if (d.kind === "ok") {
				assertPass(
					"e2e: recalled content byte-equal to original",
					d.fullText === fileContent,
					{ len: d.fullText.length },
				);
			}
			logPass("end-to-end: same content from 2 tools, recall restores original");
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
