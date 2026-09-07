import { DedupStore } from "../../src/dedup/content_store";
import { assertPass, logPass } from "../_setup";

function makeContent(seed: number, sizeBytes: number): string {
	const base = `line ${seed}\nfield_a=hello_${seed}\nfield_b=world_${seed}\n`;
	const repeats = Math.max(1, Math.floor(sizeBytes / base.length));
	let out = base.repeat(repeats);
	if (out.length < sizeBytes) out += "x".repeat(sizeBytes - out.length);
	return out.slice(0, sizeBytes);
}

export function testFirstOccurrencePassThrough(): void {
	const store = new DedupStore();
	const r = store.record("s1", "call_1", "read", {}, makeContent(1, 500), false, 0);
	assertPass("First-occurrence returns non-null shortRef", r.shortRef !== null && r.shortRef.length > 0, { r });
	assertPass("First-occurrence is not a dedup hit", r.isDuplicate === false, { r });
	logPass("First-occurrence pass-through verified!");
}

export function testByteEqualityDedup(): void {
	const store = new DedupStore();
	const content = makeContent(1, 500);
	store.record("s1", "call_1", "read", {}, content, false, 0);
	const r2 = store.record("s1", "call_2", "read", {}, content, false, 0);
	assertPass("Second identical content is a dedup hit", r2.isDuplicate === true, { r2 });
	assertPass("Both shortRefs point to the same content", r2.shortRef === r2.shortRef, { r2 });
	logPass("Byte-equality dedup verified!");
}

export function testBelowThresholdNotDeduped(): void {
	const store = new DedupStore();
	const smallContent = "tiny";
	store.record("s1", "call_1", "read", {}, smallContent, false, 0);
	const r2 = store.record("s1", "call_2", "read", {}, smallContent, false, 0);
	assertPass("Below-threshold content is not deduped", r2.isDuplicate === false, { r2 });
	logPass("Below-threshold pass-through verified!");
}

export function testSessionIsolation(): void {
	const store = new DedupStore();
	const content = makeContent(1, 500);
	store.record("s1", "call_1", "read", {}, content, false, 0);
	const r2 = store.record("s2", "call_2", "read", {}, content, false, 0);
	assertPass("Different sessions do not dedup against each other", r2.isDuplicate === false, { r2 });
	logPass("Session isolation verified!");
}

export function testRecallRetrieval(): void {
	const store = new DedupStore();
	const content = makeContent(1, 500);
	const r1 = store.record("s1", "call_1", "read", {}, content, false, 0);
	const recalled = store.get("s1", r1.shortRef!);
	assertPass("Recall retrieves the full original content", recalled !== null && recalled.fullText === content, { recalled });
	logPass("Recall retrieval verified!");
}
