import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface StreamedReadResult {
	lines: string[];
	startLine: number;
	endLine: number;
	totalLinesRead: number;
	hasMore: boolean;
	totalBytes: number;
	truncatedByBytes: boolean;
	singleLineTruncated: boolean;
	isBinary: boolean;
}

const CHUNK_SIZE = 64 * 1024;
const MAX_READ_BYTES = 50 * 1024; // 50 KB output budget
const MAX_SINGLE_LINE_BYTES = 50 * 1024;

/**
 * Hardened bounded streaming line reader.
 * Operates directly on an open file descriptor to eliminate TOCTOU races.
 * Uses StringDecoder to prevent multi-byte UTF-8 character corruption across 64 KB chunk boundaries.
 * Strictly caps single-line accumulation at 50 KB with early I/O exit to prevent O(N) heap blowup on newline-free files.
 * Memory is strictly O(1) (< 200 KB) regardless of file size.
 */
export function readStreamLineRangeFromFd(
	fd: number,
	options: {
		offset?: number;
		limit?: number;
		maxBytes?: number;
	} = {},
): StreamedReadResult {
	const offset = Math.max(1, options.offset ?? 1);
	const limit = Math.max(1, Math.min(options.limit ?? 250, 2000));
	const maxBytes = options.maxBytes ?? MAX_READ_BYTES;

	const buf = Buffer.allocUnsafe(CHUNK_SIZE);
	let currentLine = 1;
	const targetEndLine = offset + limit - 1;
	const collectedLines: string[] = [];
	let accumulatedBytes = 0;
	let truncatedByBytes = false;
	let singleLineTruncated = false;
	let hasMore = false;
	let isBinary = false;
	let checkedBinary = false;

	const lineDecoder = new StringDecoder("utf8");
	let currentLineDecoded = "";
	let currentLineAccumulatedBytes = 0;
	let skippingExcessInLine = false;

	try {
		let bytesRead = 0;
		while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, null)) > 0) {
			// Binary guard: check for 0x00 null byte in the initial 8 KB
			if (!checkedBinary) {
				checkedBinary = true;
				const probeLength = Math.min(bytesRead, 8192);
				if (buf.subarray(0, probeLength).includes(0)) {
					isBinary = true;
					break;
				}
			}

			let lineStart = 0;
			for (let i = 0; i < bytesRead; i++) {
				if (buf[i] === 0x0a) { // '\n'
					const lineSlice = buf.subarray(lineStart, i);

					if (currentLine >= offset && currentLine <= targetEndLine) {
						if (!skippingExcessInLine) {
							currentLineDecoded += lineDecoder.write(lineSlice);
							currentLineAccumulatedBytes += lineSlice.length;
						}
						// Flush any remaining characters in decoder for this line
						currentLineDecoded += lineDecoder.end();
						// Strip trailing '\r' safely across buffer boundaries
						if (currentLineDecoded.endsWith("\r")) {
							currentLineDecoded = currentLineDecoded.slice(0, -1);
						}

						const lineBytes = Buffer.byteLength(currentLineDecoded, "utf8");
						if (accumulatedBytes + lineBytes + (collectedLines.length > 0 ? 1 : 0) > maxBytes) {
							if (collectedLines.length === 0) {
								const clipped = currentLineDecoded.slice(0, Math.max(10, maxBytes - 50)) + "... <line truncated>";
								collectedLines.push(clipped);
								accumulatedBytes = Buffer.byteLength(clipped, "utf8");
							}
							truncatedByBytes = true;
							hasMore = true;
							break;
						}

						collectedLines.push(currentLineDecoded);
						accumulatedBytes += lineBytes + (collectedLines.length > 1 ? 1 : 0);
					}

					// Reset state for next line
					currentLineDecoded = "";
					currentLineAccumulatedBytes = 0;
					skippingExcessInLine = false;
					currentLine++;
					lineStart = i + 1;

					if (currentLine > targetEndLine) {
						hasMore = true;
						break;
					}
				} else {
					// Byte within a line
					if (currentLine >= offset && currentLine <= targetEndLine) {
						if (!skippingExcessInLine) {
							// Hard cap per line to prevent O(N) memory on newline-free files
							if (currentLineAccumulatedBytes + (i - lineStart + 1) > MAX_SINGLE_LINE_BYTES) {
								const safeSlice = buf.subarray(lineStart, i + 1);
								currentLineDecoded += lineDecoder.write(safeSlice);
								currentLineDecoded += lineDecoder.end();
								currentLineDecoded += "... <line truncated: exceeds 50 KB>";
								singleLineTruncated = true;
								skippingExcessInLine = true;
								// Early I/O exit: when line 1 hits the 50 KB budget, stop reading immediately
								if (collectedLines.length === 0) {
									collectedLines.push(currentLineDecoded);
									accumulatedBytes = Buffer.byteLength(currentLineDecoded, "utf8");
									truncatedByBytes = true;
									hasMore = true;
									break;
								}
							}
						}
					}
				}
			}

			if (truncatedByBytes || currentLine > targetEndLine) {
				break;
			}

			// Incomplete line remaining at end of chunk
			if (lineStart < bytesRead && currentLine >= offset && currentLine <= targetEndLine) {
				if (!skippingExcessInLine) {
					const leftover = buf.subarray(lineStart, bytesRead);
					currentLineDecoded += lineDecoder.write(leftover);
					currentLineAccumulatedBytes += leftover.length;
					if (currentLineAccumulatedBytes > MAX_SINGLE_LINE_BYTES) {
						currentLineDecoded += lineDecoder.end();
						currentLineDecoded += "... <line truncated: exceeds 50 KB>";
						singleLineTruncated = true;
						skippingExcessInLine = true;
						if (collectedLines.length === 0) {
							collectedLines.push(currentLineDecoded);
							accumulatedBytes = Buffer.byteLength(currentLineDecoded, "utf8");
							truncatedByBytes = true;
							hasMore = true;
							break;
						}
					}
				}
			}
		}

		// Trailing line without trailing newline
		if (!isBinary && !truncatedByBytes && currentLine >= offset && currentLine <= targetEndLine) {
			if (!skippingExcessInLine) {
				currentLineDecoded += lineDecoder.end();
			}
			if (currentLineDecoded.length > 0) {
				if (currentLineDecoded.endsWith("\r")) {
					currentLineDecoded = currentLineDecoded.slice(0, -1);
				}
				const lineBytes = Buffer.byteLength(currentLineDecoded, "utf8");
				if (accumulatedBytes + lineBytes <= maxBytes) {
					collectedLines.push(currentLineDecoded);
					accumulatedBytes += lineBytes;
				} else if (collectedLines.length === 0) {
					const clipped = currentLineDecoded.slice(0, Math.max(10, maxBytes - 50)) + "... <line truncated>";
					collectedLines.push(clipped);
					accumulatedBytes = Buffer.byteLength(clipped, "utf8");
					truncatedByBytes = true;
					hasMore = true;
				} else {
					truncatedByBytes = true;
					hasMore = true;
				}
			}
		}
	} finally {
		lineDecoder.end();
	}

	const endLine = offset + collectedLines.length - 1;
	return {
		lines: collectedLines,
		startLine: collectedLines.length > 0 ? offset : 0,
		endLine: collectedLines.length > 0 ? endLine : 0,
		totalLinesRead: collectedLines.length,
		hasMore,
		totalBytes: accumulatedBytes,
		truncatedByBytes,
		singleLineTruncated,
		isBinary,
	};
}
