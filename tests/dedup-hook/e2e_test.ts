import { DedupStore } from "../../src/dedup/content_store";
import { decideRecall } from "../../src/dedup/recall_tool";
import { assertPass, logPass } from "../_setup";

export function testE2EDedupHook(): void {
	const store = new DedupStore();
	const content = "line 1\nline 2\nline 3\n".repeat(20);
	const rendered = content;

	// First occurrence: hook records into the store
	const r1 = store.record("s1", "call_a", "read", { file: "a.py" }, rendered, false, 0);
	assertPass("First hook record returns a shortRef", r1.shortRef !== null, { r1 });

	// Second call with identical content: dedup hit
	const r2 = store.record("s1", "call_b", "read", { file: "a.py" }, rendered, false, 0);
	assertPass("Second identical content is dedup hit", r2.isDuplicate === true, { r2 });

	// Recall retrieves the original full text
	const decision = decideRecall(r1.shortRef!, store, "s1");
	assertPass("Recall finds the original full text via shortRef", decision.kind === "ok", { decision });
	if (decision.kind === "ok") {
		assertPass("Recalled fullText matches what was recorded", decision.fullText === rendered, { len: decision.fullText.length });
	}

	logPass("End-to-end dedup hook roundtrip verified!");
}
