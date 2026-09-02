/**
 * Per-session content-addressed dedup store.
 *
 * Trigger: SHA-256 of the rendered tool-result text. Byte-equality only.
 * Reference format: "r1", "r2", ... per-session monotonic counter.
 * LRU-bounded: oldest entry evicted when the per-session cap is exceeded.
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
	/** LRU cap per session. Oldest entries are evicted first. */
	maxEntriesPerSession?: number;
}

const DEFAULT_MIN_BYTES = 80;
const DEFAULT_MAX_ENTRIES = 256;

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
				byHash: new Map<string, string>(),
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
	 * @param isError Pass-through if true. Errors are never deduped.
	 * @param currentCompactionCounter Pass the session's current compaction
	 *        counter so the store can decide whether a prior entry is still
	 *        "live" in the LLM's context.
	 */
	record(
		sessionId: string,
		callId: string,
		fullText: string,
		isError: boolean,
		currentCompactionCounter: number,
	): RecordResult {
		// Errors and short results are never deduped. Return a fresh ref
		// (caller will not use it for a dedup notice; full text is emitted).
		if (isError || fullText.length <= this.minBytes) {
			const s = this.getOrCreateSession(sessionId);
			// Still allocate a ref so recall() can find the full text if asked,
			// but mark the entry as not dedupable.
			const shortRef = this.allocateRef(s);
			s.entries.set(shortRef, {
				shortRef,
				contentHash: hashOf(fullText),
				callId,
				fullText,
				sizeBytes: fullText.length,
				lastSeenInContext: currentCompactionCounter,
			});
			// Don't index by hash — we don't want a future identical content to
			// become a dedup reference to an error or short result.
			s.insertionOrder.push(shortRef);
			this.evictIfNeeded(s);
			return { isDuplicate: false, shortRef, priorRef: null };
		}

		const s = this.getOrCreateSession(sessionId);
		const contentHash = hashOf(fullText);
		const priorRef = s.byHash.get(contentHash);

		if (
			priorRef !== undefined &&
			s.entries.has(priorRef) &&
			s.entries.get(priorRef)!.lastSeenInContext === currentCompactionCounter
		) {
			// Duplicate and the LLM still has the prior full text. Refuse to
			// allocate a new ref; return the prior one so the caller can emit
			// the dedup notice. Promote the matched entry to MRU so an
			// access-ordered LRU does not evict a hot reference.
			this.touchInOrder(s, priorRef);
			return { isDuplicate: true, shortRef: priorRef, priorRef };
		}

		// Not a duplicate (or a stale one). Allocate a new ref and store.
		const shortRef = this.allocateRef(s);
		s.entries.set(shortRef, {
			shortRef,
			contentHash,
			callId,
			fullText,
			sizeBytes: fullText.length,
			lastSeenInContext: currentCompactionCounter,
		});
		s.byHash.set(contentHash, shortRef);
		s.insertionOrder.push(shortRef);
		this.evictIfNeeded(s);
		return { isDuplicate: false, shortRef, priorRef: null };
	}

	/**
	 * Retrieve the full text for a previously-allocated ref. Returns null
	 * if the ref is unknown in this session.
	 */
	get(sessionId: string, shortRef: string): { fullText: string; sizeBytes: number } | null {
		const s = this.bySession.get(sessionId);
		if (!s) return null;
		const entry = s.entries.get(shortRef);
		if (!entry) return null;
		return { fullText: entry.fullText, sizeBytes: entry.sizeBytes };
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

	private evictIfNeeded(s: SessionState): void {
		while (s.insertionOrder.length > this.maxEntries) {
			const oldestRef = s.insertionOrder.shift();
			if (oldestRef === undefined) break;
			const oldest = s.entries.get(oldestRef);
			if (oldest) {
				s.entries.delete(oldestRef);
				s.byHash.delete(oldest.contentHash);
			}
		}
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
	byHash: Map<string, string>;
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
