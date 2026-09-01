import { CodeChunk } from "./search_chunker";

export interface BM25SearchResult {
	chunkId: string;
	score: number;
	matches: string[];
}

/**
 * Specialized code tokenizer handling CamelCase, snake_case, identifiers and symbols.
 */
export function tokenizeCode(text: string): string[] {
	if (!text) return [];

	const rawTokens = text.match(/[a-zA-Z0-9_]+/g) || [];
	const tokens: string[] = [];

	for (const raw of rawTokens) {
		const lower = raw.toLowerCase();
		if (lower.length >= 2) {
			tokens.push(lower);
		}

		// Split snake_case
		if (raw.includes("_")) {
			const parts = raw.split("_");
			for (const p of parts) {
				const pl = p.toLowerCase();
				if (pl.length >= 2) tokens.push(pl);
			}
		}

		// Split camelCase and PascalCase (e.g. "verifySignature" -> "verify", "signature")
		const camelParts = raw.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
		if (camelParts.length > 1) {
			for (const cp of camelParts) {
				const cpl = cp.toLowerCase();
				if (cpl.length >= 2) tokens.push(cpl);
			}
		}
	}

	return tokens;
}

export class BM25Engine {
	private k1 = 1.2;
	private b = 0.75;

	// chunkId -> term frequency map: term -> count
	private docTermFreqs: Map<string, Map<string, number>> = new Map();
	// chunkId -> total token count in document
	private docLengths: Map<string, number> = new Map();
	// term -> document frequency (number of docs containing term)
	private termDocFreqs: Map<string, number> = new Map();
	// term -> Set of chunkIds (Inverted index for O(Σ matches) query scanning)
	private postings: Map<string, Set<string>> = new Map();

	private totalDocs = 0;
	private avgDocLength = 0;

	public clear(): void {
		this.docTermFreqs.clear();
		this.docLengths.clear();
		this.termDocFreqs.clear();
		this.postings.clear();
		this.totalDocs = 0;
		this.avgDocLength = 0;
	}

	/**
	 * Index a list of CodeChunks into the BM25 inverted index.
	 */
	public indexChunks(chunks: CodeChunk[]): void {
		for (const chunk of chunks) {
			this.addChunk(chunk);
		}
		this.recalculateStats();
	}

	public addChunk(chunk: CodeChunk): void {
		// Combine breadcrumb, signature and content with extra weight for signature/name
		const weightedText = `${chunk.symbolName} ${chunk.symbolName} ${chunk.signature} ${chunk.breadcrumb}\n${chunk.content}`;
		const tokens = tokenizeCode(weightedText);

		const tfMap = new Map<string, number>();
		for (const t of tokens) {
			tfMap.set(t, (tfMap.get(t) || 0) + 1);
		}

		this.docTermFreqs.set(chunk.id, tfMap);
		this.docLengths.set(chunk.id, tokens.length);

		for (const term of tfMap.keys()) {
			this.termDocFreqs.set(term, (this.termDocFreqs.get(term) || 0) + 1);
			let chunkSet = this.postings.get(term);
			if (!chunkSet) {
				chunkSet = new Set();
				this.postings.set(term, chunkSet);
			}
			chunkSet.add(chunk.id);
		}

		this.totalDocs++;
	}

	/**
	 * Remove all chunks associated with a specific relative file path.
	 */
	public removeFile(filePath: string): void {
		const prefix = `${filePath}:`;
		for (const chunkId of Array.from(this.docTermFreqs.keys())) {
			if (chunkId.startsWith(prefix) || chunkId.includes(filePath)) {
				const tfMap = this.docTermFreqs.get(chunkId);
				if (tfMap) {
					for (const term of tfMap.keys()) {
						const count = (this.termDocFreqs.get(term) || 1) - 1;
						if (count <= 0) {
							this.termDocFreqs.delete(term);
						} else {
							this.termDocFreqs.set(term, count);
						}
						const chunkSet = this.postings.get(term);
						if (chunkSet) {
							chunkSet.delete(chunkId);
							if (chunkSet.size === 0) {
								this.postings.delete(term);
							}
						}
					}
				}
				this.docTermFreqs.delete(chunkId);
				this.docLengths.delete(chunkId);
				this.totalDocs--;
			}
		}
		this.recalculateStats();
	}

	public recalculateStats(): void {
		let totalLength = 0;
		for (const len of this.docLengths.values()) {
			totalLength += len;
		}
		this.totalDocs = this.docLengths.size;
		this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 0;
	}

	/**
	 * Search the BM25 index with a query string.
	 */
	public search(query: string, limit = 50): BM25SearchResult[] {
		if (this.totalDocs === 0) return [];
		const queryTokens = Array.from(new Set(tokenizeCode(query)));
		if (queryTokens.length === 0) return [];

		const scores: Map<string, { score: number; matches: string[] }> = new Map();

		for (const term of queryTokens) {
			const n = this.termDocFreqs.get(term) || 0;
			if (n === 0) continue;

			// Okapi BM25 Inverse Document Frequency
			const idf = Math.log(1 + (this.totalDocs - n + 0.5) / (n + 0.5));
			const matchingChunkIds = this.postings.get(term);
			if (!matchingChunkIds) continue;

			for (const chunkId of matchingChunkIds) {
				const tfMap = this.docTermFreqs.get(chunkId);
				if (!tfMap) continue;
				const tf = tfMap.get(term) || 0;
				if (tf === 0) continue;

				const docLen = this.docLengths.get(chunkId) || this.avgDocLength;
				const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (docLen / (this.avgDocLength || 1))));
				const termScore = idf * tfNorm;

				const current = scores.get(chunkId) || { score: 0, matches: [] };
				current.score += termScore;
				current.matches.push(term);
				scores.set(chunkId, current);
			}
		}

		return Array.from(scores.entries())
			.map(([chunkId, data]) => ({ chunkId, score: data.score, matches: data.matches }))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}
