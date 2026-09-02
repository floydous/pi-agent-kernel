/**
 * Per-session content-addressed dedup store.
 *
 * Trigger: SHA-256 of the rendered tool-result text combined with the tool
 * name and a stable digest of the input parameters. Same content + same
 * tool + same params = dedup. Same content + different tool or different
 * params = new ref. This is a strict byte-equality rule with one extra
 * dimension (input identity) so that `read(file, offset=1, limit=200)`
 * and `read(file, offset=100, limit=100)` are not deduped against each
 * other, even if the rendered bytes happen to overlap.
 *
 * Reference format: "r1", "r2", ... per-session monotonic counter.
 * LRU-bounded: oldest entries are evicted when the per-session cap is
 * exceeded, with a preference for evicting entries the LLM has already
 * lost track of (entries whose `lastSeenInContext` is below the session's
 * current compaction counter).
 *
 * Compaction safety: each entry records `lastSeenInContext` (the compaction
 * counter value at the time the result was emitted). A duplicate is only
 * deduped when the prior entry's `lastSeenInContext` matches the current
 * compaction counter for the session — meaning the LLM still has the prior
 * full text in its current context. After any compaction, the next duplicate
 * is treated as a new first occurrence.
 */

import * as crypto from "node:crypto";

export interface DedupEntry {
	shortRef: string;
	contentHash: string;
	/** Tool name (e.g. "read", "code_search", "bash"). */
	toolName: string;
	/** Short hex digest of the input parameters; 4 hex chars. */
	paramsKey: string;
	callId: string;
	fullText: string;
	sizeBytes: number;
	lastSeenInContext: number;
}

export interface RecordResult {
	isDuplicate: boolean;
	shortRef: string;
	priorRef: string | null;
}

export interface DedupStoreOptions {
	/** Don't record or dedup results whose text length is <= this many bytes. */
	minBytes?: number;
	/**
	 * LRU cap per session. Oldest entries are evicted first, with a
	 * preference for evicting entries the LLM has lost track of (post-
	 * compaction) before evicting still-live ones.
	 */
	maxEntriesPerSession?: number;
}

const DEFAULT_MIN_BYTES = 80;
const DEFAULT_MAX_ENTRIES = 1024;

export class DedupStore {
	private bySession = new Map<string, SessionState>();
	private minBytes: number;
	private maxEntries: number;

	constructor(options: DedupStoreOptions = {}) {
		this.minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
		this.maxEntries = options.maxEntriesPerSession ?? DEFAULT_MAX_ENTRIES;
	}

	private getOrCreateSession(sessionId: string): SessionState {
		let s = this.bySession.get(sessionId);
		if (!s) {
			s = {
				entries: new Map<string, DedupEntry>(),
				byDedupKey: new Map<string, string>(),
				insertionOrder: [],
				compactionCounter: 0,
				nextRefNumber: 1,
			};
			this.bySession.set(sessionId, s);
		}
		return s;
	}

	/**
	 * Record a tool result and decide whether the caller should emit a dedup
	 * reference or the full text.
	 *
	 * @param toolName The name of the tool that produced the result. Used
	 *        as part of the dedup key so `read` and `code_search` of the
	 *        same file produce different refs.
	 * @param inputParams The tool's input parameters as a plain object
	 *        (e.g. `event.input`). The store applies a stable key-sorted
	 *        stringify so insertion order does not affect the dedup key.
	 * @param isError Pass-through if true. Errors are never deduped.
	 * @param currentCompactionCounter Pass the session's current compaction
	 *        counter so the store can decide whether a prior entry is still
	 *        "live" in the LLM's context.
	 */
	record(
		sessionId: string,
		callId: string,
		toolName: string,
		inputParams: unknown,
		fullText: string,
		isError: boolean,
		currentCompactionCounter: number,
	): RecordResult {
		// Errors and short results are never deduped. Return a fresh ref
		// (caller will not use it for a dedup notice; full text is emitted).
		if (isError || fullText.length <= this.minBytes) {
			const s = this.getOrCreateSession(sessionId);
			const shortRef = this.allocateRef(s);
			const paramsKey = shortParamsKey(inputParams);
			s.entries.set(shortRef, {
				shortRef,
				contentHash: hashOf(fullText),
				toolName,
				paramsKey,
				callId,
				fullText,
				sizeBytes: fullText.length,
				lastSeenInContext: currentCompactionCounter,
			});
			// Don't index by dedup key — we don't want a future identical
			// content to become a dedup reference to an error or short result.
			s.insertionOrder.push(shortRef);
			this.evictIfNeeded(s);
			return { isDuplicate: false, shortRef, priorRef: null };
		}

		const s = this.getOrCreateSession(sessionId);
		const contentHash = hashOf(fullText);
		const paramsKey = shortParamsKey(inputParams);
		const dedupKey = contentHash + ":" + toolName + ":" + paramsKey;
		const priorRef = s.byDedupKey.get(dedupKey);

		if (
			priorRef !== undefined &&
			s.entries.has(priorRef) &&
			s.entries.get(priorRef)!.lastSeenInContext === currentCompactionCounter
		) {
			// Duplicate AND same tool + same params AND the LLM still has
			// the prior full text. Promote the matched entry to MRU so an
			// access-ordered LRU does not evict a hot reference.
			this.touchInOrder(s, priorRef);
			return { isDuplicate: true, shortRef: priorRef, priorRef };
		}

		// Not a duplicate (or a stale one — pre-compaction). Allocate a new
		// ref and store. A different `toolName` or different `inputParams`
		// naturally produces a different dedupKey, so it does not dedup
		// against an existing entry even if `fullText` is byte-equal.
		const shortRef = this.allocateRef(s);
		s.entries.set(shortRef, {
			shortRef,
			contentHash,
			toolName,
			paramsKey,
			callId,
			fullText,
			sizeBytes: fullText.length,
			lastSeenInContext: currentCompactionCounter,
		});
		s.byDedupKey.set(dedupKey, shortRef);
		s.insertionOrder.push(shortRef);
		this.evictIfNeeded(s);
		return { isDuplicate: false, shortRef, priorRef: null };
	}

	/**
	 * Retrieve the full text and metadata for a previously-allocated ref.
	 * Returns null if the ref is unknown in this session.
	 */
	get(
		sessionId: string,
		shortRef: string,
	): { fullText: string; sizeBytes: number; toolName: string; paramsKey: string } | null {
		const s = this.bySession.get(sessionId);
		if (!s) return null;
		const entry = s.entries.get(shortRef);
		if (!entry) return null;
		return {
			fullText: entry.fullText,
			sizeBytes: entry.sizeBytes,
			toolName: entry.toolName,
			paramsKey: entry.paramsKey,
		};
	}

	/**
	 * Increment the per-session compaction counter. After this call, any
	 * prior entry that was recorded before the increment will fail the
	 * `lastSeenInContext === currentCompactionCounter` check on the next
	 * `record`, so the next duplicate will be treated as a new first
	 * occurrence.
	 */
	onCompaction(sessionId: string): void {
		const s = this.getOrCreateSession(sessionId);
		s.compactionCounter += 1;
	}

	/**
	 * Diagnostic accessor. Returns the current compaction counter for the
	 * session (0 if no compaction has been recorded).
	 */
	getCompactionCounter(sessionId: string): number {
		const s = this.bySession.get(sessionId);
		return s?.compactionCounter ?? 0;
	}

	/**
	 * Test-only / diagnostic. Number of entries currently held for the session.
	 */
	size(sessionId: string): number {
		return this.bySession.get(sessionId)?.entries.size ?? 0;
	}

	/**
	 * Test-only / cleanup. Drop all state for a session.
	 */
	clearSession(sessionId: string): void {
		this.bySession.delete(sessionId);
	}

	private allocateRef(s: SessionState): string {
		const n = s.nextRefNumber++;
		return `r${n}`;
	}

	/**
	 * Evict down to the cap. When choosing which entry to evict, prefer
	 * ones the LLM has already lost track of (post-compaction: their
	 * `lastSeenInContext` is below the current compaction counter). Only
	 * fall back to plain LRU (oldest in `insertionOrder`) when no such
	 * "dead" entries exist.
	 *
	 * This is the durability fix from the real-world test: previously, the
	 * LRU could evict a reference that was still visible in the LLM's
	 * context, making recall() return "no content stored". Now, anything
	 * the LLM can still see is preserved at the cost of evicting older
	 * already-summarized content.
	 */
	private evictIfNeeded(s: SessionState): void {
		while (s.insertionOrder.length > this.maxEntries) {
			// Pass 1: try to evict an entry that is already dead to the LLM
			// (lastSeenInContext is below the current compaction counter).
			let evictedAny = false;
			for (let i = 0; i < s.insertionOrder.length; i++) {
				const candidateRef = s.insertionOrder[i];
				const entry = s.entries.get(candidateRef);
				if (entry && entry.lastSeenInContext < s.compactionCounter) {
					this.evictOne(s, candidateRef);
					evictedAny = true;
					break;
				}
			}
			if (evictedAny) continue;
			// Pass 2: nothing dead to evict. Fall back to plain LRU
			// (oldest at the head of insertionOrder). This is the case
			// where the cap is too small for the current live context.
			const oldestRef = s.insertionOrder.shift();
			if (oldestRef === undefined) break;
			this.evictOne(s, oldestRef);
		}
	}

	private evictOne(s: SessionState, ref: string): void {
		const entry = s.entries.get(ref);
		if (!entry) return;
		s.entries.delete(ref);
		const dedupKey = entry.contentHash + ":" + entry.toolName + ":" + entry.paramsKey;
		// Only delete from byDedupKey if the stored ref still points to
		// this entry. (A different entry with the same dedup key may have
		// overwritten it; in that case we should not delete the new ref.)
		if (s.byDedupKey.get(dedupKey) === ref) {
			s.byDedupKey.delete(dedupKey);
		}
		const idx = s.insertionOrder.indexOf(ref);
		if (idx >= 0) s.insertionOrder.splice(idx, 1);
	}

	/** Move a ref to the most-recently-used end of the insertion order. */
	private touchInOrder(s: SessionState, ref: string): void {
		const idx = s.insertionOrder.indexOf(ref);
		if (idx === -1) return;
		s.insertionOrder.splice(idx, 1);
		s.insertionOrder.push(ref);
	}
}

interface SessionState {
	entries: Map<string, DedupEntry>;
	/** Map from `contentHash:toolName:paramsKey` to ref. */
	byDedupKey: Map<string, string>;
	/**
	 * MRU-ordered list of refs. New allocations and dedup hits push to the
	 * tail; eviction removes from the head. A hit on a prior entry promotes
	 * it to MRU so the LRU reflects actual access pattern, not just insertion.
	 */
	insertionOrder: string[];
	compactionCounter: number;
	nextRefNumber: number;
}

function hashOf(text: string): string {
	return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 4-hex-char digest of the input parameters. Accepts string or object. */
function shortParamsKey(inputParams: unknown): string {
	const s = typeof inputParams === "string" ? inputParams : stableStringify(inputParams);
	return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 4);
}

/**
 * Stable JSON stringify with sorted keys. Two equivalent objects with
 * different key insertion order produce the same string. This makes the
 * paramsKey deterministic for a given semantic input, so
 * `read({path: "a"})` and `read({path: "a"})` always match even if the
 * harness builds the object in different orders.
 */
export function stableStringify(value: unknown): string {
	return stringifyStable(value, new Set<unknown>());
}

function stringifyStable(value: unknown, seen: Set<unknown>): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	const t = typeof value;
	if (t === "string") return JSON.stringify(value);
	if (t === "number" || t === "boolean") return String(value);
	if (t === "bigint") return value.toString();
	if (Array.isArray(value)) {
		if (seen.has(value)) return '"[circular]"';
		seen.add(value);
		const parts: string[] = [];
		for (const v of value) parts.push(stringifyStable(v, seen));
		seen.delete(value);
		return "[" + parts.join(",") + "]";
	}
	if (t === "object") {
		const obj = value as Record<string, unknown>;
		if (seen.has(obj)) return '"[circular]"';
		seen.add(obj);
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const k of keys) {
			const v = obj[k];
			if (v === undefined) continue;
			parts.push(JSON.stringify(k) + ":" + stringifyStable(v, seen));
		}
		seen.delete(obj);
		return "{" + parts.join(",") + "}";
	}
	// Function, symbol, etc. — not a meaningful input parameter; skip.
	return '"[unsupported]"';
}
