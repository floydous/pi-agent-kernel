import { decideRecall } from "../../src/dedup/recall_tool";
import { DedupStore } from "../../src/dedup/content_store";
import { assertPass, logPass } from "../_setup";

export function testValidRef(): void {
	const store = new DedupStore();
	const content = "line 1\nline 2\nline 3\n".repeat(20);
	const r = store.record("s1", "c1", "read", {}, content, false, 0);
	const decision = decideRecall(r.shortRef, store, "s1");
	assertPass("valid ref: kind is 'ok'", decision.kind === "ok", { decision });
	if (decision.kind === "ok") {
		assertPass("valid ref: fullText byte-equal to original", decision.fullText === content, { len: decision.fullText.length });
		assertPass("valid ref: sizeBytes matches", decision.sizeBytes === content.length, {});
	}
	logPass("Recall valid ref returns full text verified!");
}

export function testInvalidRef(): void {
	const store = new DedupStore();
	// Ref must be in 'rN' format
	const decision = decideRecall("r-999", store, "s1");
	assertPass("invalid ref: kind is 'error' or 'not_found'", decision.kind === "error" || decision.kind === "not_found", { decision });
	logPass("Recall invalid ref returns error or not_found verified!");
}

export function testWrongSession(): void {
	const store = new DedupStore();
	const content = "x".repeat(200);
	const r = store.record("s1", "c1", "read", {}, content, false, 0);
	const decision = decideRecall(r.shortRef, store, "s2");
	assertPass("wrong session: kind is 'error' or 'not_found'", decision.kind === "error" || decision.kind === "not_found", { decision });
	logPass("Recall wrong session returns error or not_found verified!");
}
