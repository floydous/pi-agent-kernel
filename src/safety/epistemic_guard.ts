/**
 * Epistemic Read-Before-Write Guard
 *
 * Enforces the cognitive invariant that an agent must inspect and ground itself
 * in real file contents before attempting to mutate code.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { kernelDebug } from "./kernel_debug";
import { getPiHomeDir } from "../config/kernel_config";

/**
 * Extract file paths used as inputs by known shell content-reader commands.
 * This is command-shape evidence recorded during tool-call preflight; it does
 * not claim that a shell command produced output or that the agent understood it.
 */
const CONTENT_READING_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"sed",
	"awk",
	"grep",
	"rg",
	"less",
	"more",
]);

const NON_CONTENT_SEARCH_FLAGS = new Set(["c", "l", "L", "q"]);

function commandName(token: string): string {
	return path
		.basename(token)
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/i, "");
}

/** Resolve the path forms accepted by Pi's file tools, including ~ paths. */
export function resolveUserPath(
	filePath: string,
	cwd = process.cwd(),
): string {
	const normalized = filePath.trim();
	const expanded =
		normalized === "~"
			? os.homedir()
			: normalized.startsWith("~/") || normalized.startsWith("~\\")
				? path.join(os.homedir(), normalized.slice(2))
				: normalized;
	return path.isAbsolute(expanded)
		? path.resolve(expanded)
		: path.resolve(cwd, expanded);
}

export function extractInspectedFilesFromCommand(
	command: string,
	cwd: string = process.cwd(),
): string[] {
	if (!command || typeof command !== "string") return [];

	const inspected: string[] = [];
	const subCommands = command.split(/[|;&\n]+/);

	for (const sub of subCommands) {
		const trimmed = sub.trim();
		if (!trimmed) continue;

		const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
		const tokens: string[] = [];
		let match: RegExpExecArray | null;

		while ((match = regex.exec(trimmed)) !== null) {
			let token = match[0].trim();
			if (
				(token.startsWith('"') && token.endsWith('"')) ||
				(token.startsWith("'") && token.endsWith("'"))
			) {
				token = token.slice(1, -1);
			}
			if (token) tokens.push(token);
		}

		if (tokens.length === 0) continue;

		const command = commandName(tokens[0]);
		if (!CONTENT_READING_COMMANDS.has(command)) continue;

		if (
			(command === "grep" || command === "rg") &&
			tokens.slice(1).some((token) => {
				if (
					token === "--count" ||
					token === "--files-with-matches" ||
					token === "--files-without-match" ||
					token === "--quiet" ||
					token === "--silent"
				) {
					return true;
				}
				return (
					token.startsWith("-") &&
					!token.startsWith("--") &&
					[...token.slice(1)].some((flag) => NON_CONTENT_SEARCH_FLAGS.has(flag))
				);
			})
		) {
			continue;
		}

		const positional = tokens
			.slice(1)
			.filter(
				(token) =>
					!token.startsWith("-") && ![">", ">>", "<", "2>", "2>&1"].includes(token),
			);
		let candidates: string[];
		if (command === "grep" || command === "rg" || command === "awk") {
			candidates = positional.slice(1);
		} else if (command === "sed") {
			candidates = positional.slice(1);
		} else {
			candidates = positional;
		}

		for (const token of candidates) {
			try {
				const resolved = resolveUserPath(token, cwd);
				if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
					inspected.push(resolved);
				}
			} catch (error) {
				kernelDebug(error);
			}
		}
	}

	return Array.from(new Set(inspected));
}

export interface EvidenceRange {
	/** Inclusive 1-based source line. */
	startLine: number;
	/** Inclusive 1-based source line. */
	endLine: number;
}

export interface EvidenceCoverage {
	/** True only when the model-visible result represented the complete file. */
	complete: boolean;
	ranges: EvidenceRange[];
	totalLines?: number;
}

export type EvidenceProvenance =
	| "read"
	| "symbol"
	| "search"
	| "lsp"
	| "bash"
	| "ast_search"
	| "code_search"
	| "edit"
	| "write";

export interface SearchHit {
	line: number;
	text?: string;
}

export interface EvidenceOptions {
	coverage?: EvidenceCoverage;
	provenance?: EvidenceProvenance;
	query?: string;
	searchHits?: SearchHit[];
}

export interface ContextEvidence {
	sessionId: string;
	filePath: string;
	kind: "read" | "search";
	/** SHA-256 snapshot of the file version observed by the tool. */
	snapshot: string;
	coverage: EvidenceCoverage;
	provenance: EvidenceProvenance;
	query?: string;
	searchHits?: SearchHit[];
}

interface InspectionEvidence {
	kind: "read" | "search";
	fingerprint: string;
	coverage: EvidenceCoverage;
	provenance: EvidenceProvenance;
	query?: string;
	searchHits?: SearchHit[];
}

function normalizeRanges(
	ranges: EvidenceRange[],
	totalLines?: number,
): EvidenceRange[] {
	const valid = ranges
		.filter(
			(range) =>
				Number.isFinite(range.startLine) &&
				Number.isFinite(range.endLine) &&
				range.startLine >= 1 &&
				range.endLine >= range.startLine,
		)
		.map((range) => ({
			startLine: Math.floor(range.startLine),
			endLine: Math.floor(
				totalLines === undefined
					? range.endLine
					: Math.min(range.endLine, totalLines),
			),
		}))
		.filter((range) => range.endLine >= range.startLine)
		.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

	const merged: EvidenceRange[] = [];
	for (const range of valid) {
		const previous = merged[merged.length - 1];
		if (previous && range.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, range.endLine);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function normalizeCoverage(coverage?: EvidenceCoverage): EvidenceCoverage {
	const totalLines =
		coverage?.totalLines === undefined
			? undefined
			: Math.max(0, Math.floor(coverage.totalLines));
	return {
		complete: coverage?.complete ?? true,
		ranges: normalizeRanges(coverage?.ranges || [], totalLines),
		...(totalLines === undefined ? {} : { totalLines }),
	};
}

function mergeCoverage(
	first: EvidenceCoverage,
	second: EvidenceCoverage,
): EvidenceCoverage {
	const totalLines = second.totalLines ?? first.totalLines;
	const complete = first.complete || second.complete;
	return {
		complete,
		ranges: normalizeRanges(
			[...first.ranges, ...second.ranges],
			totalLines,
		),
		...(totalLines === undefined ? {} : { totalLines }),
	};
}

function mergeEvidence(
	previous: InspectionEvidence,
	fingerprint: string,
	kind: "read" | "search",
	coverage: EvidenceCoverage,
	provenance: EvidenceProvenance,
	query?: string,
	searchHits?: SearchHit[],
): InspectionEvidence {
	if (previous.fingerprint !== fingerprint) {
		return {
			kind,
			fingerprint,
			coverage,
			provenance,
			...(query === undefined ? {} : { query }),
			...(searchHits === undefined || searchHits.length === 0 ? {} : { searchHits }),
		};
	}
	// Once marked read, retain read kind unless reset
	const mergedKind = previous.kind === "read" || kind === "read" ? "read" : "search";
	const combinedHits = [
		...(previous.searchHits || []),
		...(searchHits || []),
	];
	const uniqueHits = combinedHits.length > 0
		? Array.from(new Map(combinedHits.map((h) => [h.line, h])).values()).sort((a, b) => a.line - b.line)
		: undefined;

	return {
		...previous,
		kind: mergedKind,
		coverage: mergeCoverage(previous.coverage, coverage),
		provenance,
		...(query === undefined ? {} : { query }),
		...(uniqueHits ? { searchHits: uniqueHits } : {}),
	};
}

/** Convert a collection of line numbers into sorted, merged 1-based line ranges. */
export function linesToRanges(lines: Iterable<number>): EvidenceRange[] {
	const sorted = Array.from(lines)
		.filter((n) => Number.isFinite(n) && n >= 1)
		.map((n) => Math.floor(n))
		.sort((a, b) => a - b);
	if (sorted.length === 0) return [];

	const ranges: EvidenceRange[] = [];
	let start = sorted[0];
	let prev = sorted[0];

	for (let i = 1; i < sorted.length; i++) {
		const curr = sorted[i];
		if (curr === prev) continue;
		if (curr === prev + 1) {
			prev = curr;
		} else {
			ranges.push({ startLine: start, endLine: prev });
			start = curr;
			prev = curr;
		}
	}
	ranges.push({ startLine: start, endLine: prev });
	return ranges;
}

export interface GrepParseOutput extends Map<string, number[]> {
	searchHits?: Map<string, SearchHit[]>;
}

/**
 * Parse stdout from grep / ripgrep, capturing file paths, emitted line numbers, and search hits.
 */
export function parseGrepOutput(
	outputText: string,
	candidateFiles: string[],
	cwd = process.cwd(),
): GrepParseOutput {
	const fileLinesMap = new Map<string, Set<number>>();
	const searchHitsMap = new Map<string, SearchHit[]>();
	if (!outputText || typeof outputText !== "string") {
		const empty: GrepParseOutput = new Map();
		empty.searchHits = searchHitsMap;
		return empty;
	}

	const normalizedCandidates = new Map<string, string>();
	for (const cand of candidateFiles) {
		const abs = path.isAbsolute(cand) ? path.normalize(cand) : path.resolve(cwd, cand);
		normalizedCandidates.set(cand, abs);
		normalizedCandidates.set(abs, abs);
		const rel = path.relative(cwd, abs).replace(/\\/g, "/");
		normalizedCandidates.set(rel, abs);
	}

	const lines = outputText.split(/\r?\n/);
	for (const line of lines) {
		const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
		if (!cleanLine || cleanLine === "--" || cleanLine.startsWith("--") && cleanLine.trim() === "--") continue;

		// 1. Single file: "123:code" (hit) or "123-context" (context)
		const singleMatch = cleanLine.match(/^(\d+)([:-])(.*)$/);
		if (singleMatch && candidateFiles.length === 1) {
			const lineNum = parseInt(singleMatch[1], 10);
			const isHit = singleMatch[2] === ":";
			const text = singleMatch[3]?.trim();
			const targetPath = normalizedCandidates.get(candidateFiles[0]) || path.resolve(cwd, candidateFiles[0]);
			if (!fileLinesMap.has(targetPath)) fileLinesMap.set(targetPath, new Set());
			fileLinesMap.get(targetPath)!.add(lineNum);
			if (isHit) {
				if (!searchHitsMap.has(targetPath)) searchHitsMap.set(targetPath, []);
				searchHitsMap.get(targetPath)!.push({ line: lineNum, text });
			}
			continue;
		}

		// 2. Multi-file: "path/to/file.ts:123:code" or "path/to/file.ts-123-context"
		// Match lines: colons never appear inside path segments (except drive letter prefix).
		const matchHit = cleanLine.match(
			/^((?:[a-zA-Z]:[\\\/])?[^:\r\n]+):(\d+):(?:\d+:)?(.*)$/,
		);
		// Context lines: anchor extension to avoid splitting on "-<digits>-" in folder/file names.
		const contextHit = !matchHit
			? cleanLine.match(
					/^((?:[a-zA-Z]:[\\\/])?[^:\r\n]+?\.[a-zA-Z0-9_]+)-(\d+)-(.*)$/,
				) ||
				cleanLine.match(
					/^((?:[a-zA-Z]:[\\\/])?[^:\r\n]+?)-(\d+)-(.*)$/,
				)
			: null;

		const parsedHit = matchHit || contextHit;
		if (parsedHit) {
			const rawPath = parsedHit[1].trim();
			const lineNum = parseInt(parsedHit[2], 10);
			const isHit = Boolean(matchHit);
			const text = parsedHit[3]?.trim();
			let absPath =
				normalizedCandidates.get(rawPath) ||
				normalizedCandidates.get(path.resolve(cwd, rawPath)) ||
				(fs.existsSync(path.resolve(cwd, rawPath)) ? path.resolve(cwd, rawPath) : null);

			if (!absPath) {
				for (const cand of candidateFiles) {
					const candNorm = (path.isAbsolute(cand) ? cand : path.resolve(cwd, cand)).replace(/\\/g, "/");
					if (candNorm.endsWith("/" + rawPath) || candNorm.endsWith(rawPath)) {
						absPath = candNorm;
						break;
					}
				}
			}

			if (absPath && Number.isFinite(lineNum) && lineNum >= 1) {
				if (!fileLinesMap.has(absPath)) fileLinesMap.set(absPath, new Set());
				fileLinesMap.get(absPath)!.add(lineNum);
				if (isHit) {
					if (!searchHitsMap.has(absPath)) searchHitsMap.set(absPath, []);
					searchHitsMap.get(absPath)!.push({ line: lineNum, text });
				}
				continue;
			}
		}

		// 3. Polyglot compiler error / test runner stack traces
		// - Rust: " --> src/upstream.rs:736:9"
		// - Python: "  File \"src/app.py\", line 45, in test"
		// - Vitest / Jest: " ❯ src/checks.ts:288:61" or " at Object.<anonymous> (file.ts:12:3)"
		// - Go / GCC: "main.go:12:3: error"
		// - C# / MSBuild: "file.cs(12,3): error"
		const traceMatch =
			cleanLine.match(/(?:-->|\s+at|\s+❯|File\s+["']?)\s*([^\s"(),]+\.[a-zA-Z0-9]+)(?:["']?)(?:[:(]|\s*,?\s*line\s+)(\d+)/i) ||
			cleanLine.match(/(?:^|[\s(])([^\s()]+\.[a-zA-Z0-9]+)[:(](\d+)(?:[:,\s)]|$)/);

		if (traceMatch) {
			const rawPath = traceMatch[1].trim();
			const lineNum = parseInt(traceMatch[2], 10);
			let absPath =
				normalizedCandidates.get(rawPath) ||
				normalizedCandidates.get(path.resolve(cwd, rawPath)) ||
				(fs.existsSync(path.resolve(cwd, rawPath)) && fs.statSync(path.resolve(cwd, rawPath)).isFile()
					? path.resolve(cwd, rawPath)
					: null);

			if (!absPath) {
				for (const cand of candidateFiles) {
					const candNorm = (path.isAbsolute(cand) ? cand : path.resolve(cwd, cand)).replace(/\\/g, "/");
					if (candNorm.endsWith("/" + rawPath) || candNorm.endsWith(rawPath)) {
						absPath = candNorm;
						break;
					}
				}
			}

			if (absPath && Number.isFinite(lineNum) && lineNum >= 1) {
				if (!fileLinesMap.has(absPath)) fileLinesMap.set(absPath, new Set());
				// Ingest compiler error line locus and surrounding window [L-2, L+2]
				for (let i = Math.max(1, lineNum - 2); i <= lineNum + 2; i++) {
					fileLinesMap.get(absPath)!.add(i);
				}
				if (!searchHitsMap.has(absPath)) searchHitsMap.set(absPath, []);
				searchHitsMap.get(absPath)!.push({ line: lineNum });
			}
		}
	}

	const result: GrepParseOutput = new Map<string, number[]>();
	for (const [file, set] of fileLinesMap.entries()) {
		result.set(file, Array.from(set).sort((a, b) => a - b));
	}
	result.searchHits = searchHitsMap;
	return result;
}

/** Parse shell paging / slicing commands (head, tail, sed). */
export function parsePagingAndDiffOutput(
	command: string,
	outputText: string,
	candidateFiles: string[],
	cwd = process.cwd(),
): Map<string, number[]> {
	const result = new Map<string, number[]>();
	if (candidateFiles.length === 0 || !outputText) return result;

	const targetPath = path.isAbsolute(candidateFiles[0])
		? path.normalize(candidateFiles[0])
		: path.resolve(cwd, candidateFiles[0]);

	let sourceLines: string[];
	try {
		const sourceText = fs.readFileSync(targetPath, "utf8").replace(/\r\n/g, "\n");
		sourceLines = sourceText.split("\n");
		if (sourceText.endsWith("\n")) sourceLines.pop();
	} catch {
		return result;
	}

	const outputLines = outputText.replace(/\r\n/g, "\n").split("\n");
	if (outputLines.at(-1) === "") outputLines.pop();
	if (outputLines.length === 0) return result;

	const matchesRange = (start: number, end: number): boolean => {
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 1 ||
			end < start ||
			end > sourceLines.length
		) {
			return false;
		}
		const expected = sourceLines.slice(start - 1, end);
		return (
			expected.length === outputLines.length &&
			expected.every((line, index) => line === outputLines[index])
		);
	};

	const headMatch = command.match(/\bhead\b.*?-n\s*(\d+)/i);
	if (headMatch) {
		const end = Math.min(parseInt(headMatch[1]!, 10), sourceLines.length);
		if (end > 0 && matchesRange(1, end)) {
			result.set(targetPath, Array.from({ length: end }, (_, index) => index + 1));
		}
		return result;
	}

	const tailMatch = command.match(/\btail\b.*?-n\s*(\d+)/i);
	if (tailMatch) {
		const count = Math.min(parseInt(tailMatch[1]!, 10), sourceLines.length);
		const start = sourceLines.length - count + 1;
		if (count > 0 && matchesRange(start, sourceLines.length)) {
			result.set(targetPath, Array.from({ length: count }, (_, index) => start + index));
		}
		return result;
	}

	const sedMatch = command.match(/\bsed\b.*?-n\s*['"]?(\d+),(\d+)p['"]?/i);
	if (sedMatch) {
		const start = parseInt(sedMatch[1]!, 10);
		const end = parseInt(sedMatch[2]!, 10);
		if (matchesRange(start, end)) {
			result.set(targetPath, Array.from({ length: end - start + 1 }, (_, index) => start + index));
		}
	}

	return result;
}

function coversRanges(
	coverage: EvidenceCoverage,
	targetRanges: EvidenceRange[],
): boolean {
	if (coverage.complete) return true;
	const normalizedTargets = normalizeRanges(targetRanges, coverage.totalLines);
	return normalizedTargets.length > 0 && normalizedTargets.every((target) =>
		coverage.ranges.some(
			(range) =>
				range.startLine <= target.startLine && range.endLine >= target.endLine,
		),
	);
}

export function getInspectionStateFilePath(sessionId: string, cwd = process.cwd()): string {
	const safeSessionId = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
	const canonicalWorkspace = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
	const workspaceId = crypto
		.createHash("sha256")
		.update(process.platform === "win32" ? canonicalWorkspace.toLowerCase() : canonicalWorkspace)
		.digest("hex")
		.slice(0, 24);
	const baseDir = path.join(getPiHomeDir(), "cache", "agent-kernel", "sessions", workspaceId, safeSessionId);
	return path.join(baseDir, "inspection-state.json");
}

export function saveSessionInspectionState(
	sessionId: string,
	evidenceMap: Map<string, InspectionEvidence>,
	cwd = process.cwd(),
): void {
	if (!sessionId || evidenceMap.size === 0) return;
	try {
		const filePath = getInspectionStateFilePath(sessionId, cwd);
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

		const canonicalWorkspace = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
		const records: Record<string, any> = {};
		for (const [absPath, ev] of evidenceMap.entries()) {
			const rel = path.relative(canonicalWorkspace, absPath).replace(/\\/g, "/");
			if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
			records[rel] = {
				kind: ev.kind,
				fingerprint: ev.fingerprint,
				coverage: ev.coverage,
				provenance: ev.provenance,
				query: ev.query,
				searchHits: ev.searchHits?.map((h) => ({ line: h.line })),
			};
		}

		const tmpPath = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
		fs.writeFileSync(
			tmpPath,
			JSON.stringify({ version: 1, workspace: canonicalWorkspace, records }, null, 2),
			{ encoding: "utf8", mode: 0o600 },
		);
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		kernelDebug(err);
	}
}

export function loadSessionInspectionState(
	sessionId: string,
	cwd = process.cwd(),
): Map<string, InspectionEvidence> {
	const result = new Map<string, InspectionEvidence>();
	if (!sessionId) return result;
	try {
		const filePath = getInspectionStateFilePath(sessionId, cwd);
		if (!fs.existsSync(filePath)) return result;
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return result;

		const raw = fs.readFileSync(filePath, "utf8");
		let data: any;
		try {
			data = JSON.parse(raw);
		} catch {
			return result;
		}
		if (!data || data.version !== 1 || !data.records || typeof data.records !== "object") return result;

		const canonicalWorkspace = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
		for (const [relPath, rec] of Object.entries(data.records as Record<string, any>)) {
			if (!relPath || typeof relPath !== "string" || relPath.includes("\0")) continue;
			const absPath = path.resolve(canonicalWorkspace, relPath);
			const relCheck = path.relative(canonicalWorkspace, absPath).replace(/\\/g, "/");
			if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) continue;

			if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
			// Ensure symlinks pointing outside workspace root are rejected
			const canonicalFile = fs.realpathSync(absPath);
			const realRelCheck = path.relative(canonicalWorkspace, canonicalFile).replace(/\\/g, "/");
			if (realRelCheck.startsWith("..") || path.isAbsolute(realRelCheck)) continue;

			const content = fs.readFileSync(absPath);
			const currentFingerprint = crypto.createHash("sha256").update(content).digest("hex");
			if (currentFingerprint !== rec.fingerprint) continue;

			const normalized = process.platform === "win32" ? absPath.toLowerCase() : absPath;
			const hits = Array.isArray(rec.searchHits)
				? rec.searchHits
						.filter((h: any) => h && typeof h.line === "number" && Number.isFinite(h.line) && h.line >= 1)
						.map((h: any) => ({ line: Math.floor(h.line) }))
				: undefined;

			result.set(normalized, {
				kind: rec.kind === "read" ? "read" : "search",
				fingerprint: rec.fingerprint,
				coverage: normalizeCoverage(rec.coverage),
				provenance: rec.provenance || "read",
				query: rec.query,
				searchHits: hits,
			});
		}
	} catch (err) {
		kernelDebug(err);
	}
	return result;
}

export class EpistemicGuard {
	private inspectedFilesBySession: Map<string, Map<string, InspectionEvidence>> =
		new Map();

	private resolvePath(filePath: string, cwd = process.cwd()): string {
		return resolveUserPath(filePath, cwd);
	}

	/**
	 * Resolve existing symlinks while retaining missing path segments. Broken
	 * symlinks throw so callers can fail closed instead of writing through one.
	 */
	private canonicalPath(resolvedPath: string): string {
		const missing: string[] = [];
		let current = path.normalize(resolvedPath);

		while (!fs.existsSync(current)) {
			try {
				if (fs.lstatSync(current).isSymbolicLink()) {
					throw new Error(`Broken symbolic link: ${current}`);
				}
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}

			const parent = path.dirname(current);
			if (parent === current) return path.normalize(resolvedPath);
			missing.unshift(path.basename(current));
			current = parent;
		}

		return path.join(fs.realpathSync(current), ...missing);
	}

	/** Normalize a path for tracking across relative/absolute and symlink forms. */
	private normalize(filePath: string, cwd = process.cwd()): string {
		const isWindows = process.platform === "win32";
		try {
			const normalized = path.normalize(
				this.canonicalPath(this.resolvePath(filePath, cwd)),
			);
			return isWindows ? normalized.toLowerCase() : normalized;
		} catch {
			const normalized = path.normalize(this.resolvePath(filePath, cwd));
			return isWindows ? normalized.toLowerCase() : normalized;
		}
	}

	private fingerprint(
		filePath: string,
		cwd = process.cwd(),
		content?: string | Buffer,
	): string | null {
		try {
			const resolved = this.resolvePath(filePath, cwd);
			if (content === undefined) {
				if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
					return null;
				}
				content = fs.readFileSync(resolved);
			}
			return crypto.createHash("sha256").update(content).digest("hex");
		} catch {
			return null;
		}
	}

	/**
	 * Enforce workspace containment, including symlink resolution. This check is
	 * independent of the optional inspection setting.
	 */
	private isWithinRoot(filePath: string, rootPath: string): boolean {
		try {
			const isWindows = process.platform === "win32";
			const root = path.normalize(this.canonicalPath(path.resolve(rootPath)));
			const target = path.normalize(
				this.canonicalPath(this.resolvePath(filePath, rootPath)),
			);
			const normalizedRoot = isWindows ? root.toLowerCase() : root;
			const normalizedTarget = isWindows ? target.toLowerCase() : target;
			const relative = path.relative(normalizedRoot, normalizedTarget);
			return (
				relative === "" ||
				(!relative.startsWith(`..${path.sep}`) &&
					relative !== ".." &&
					!path.isAbsolute(relative))
			);
		} catch {
			return false;
		}
	}

	private isWithinWorkspace(filePath: string, cwd: string): boolean {
		// The OS temp directory is the narrow, disposable scratch area allowed for
		// measurements and generated intermediates. Existing files there still pass
		// through the normal read-before-write and freshness checks below.
		return (
			this.isWithinRoot(filePath, cwd) ||
			this.isWithinRoot(filePath, os.tmpdir())
		);
	}

	private persistSessionState(sessionId: string, cwd = process.cwd()): void {
		const evidence = this.inspectedFilesBySession.get(sessionId);
		if (evidence) {
			saveSessionInspectionState(sessionId, evidence, cwd);
		}
	}

	private getSessionEvidence(
		sessionId: string,
		cwd = process.cwd(),
	): Map<string, InspectionEvidence> {
		let evidence = this.inspectedFilesBySession.get(sessionId);
		if (!evidence) {
			evidence = loadSessionInspectionState(sessionId, cwd);
			this.inspectedFilesBySession.set(sessionId, evidence);
		}
		return evidence;
	}

	/** Record a successful file read together with its observed content hash. */
	public recordFileRead(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
		content?: string | Buffer,
		options: EvidenceOptions = {},
	): void {
		if (!filePath) return;
		const fingerprint = this.fingerprint(filePath, cwd, content);
		if (!fingerprint) return;
		const normalized = this.normalize(filePath, cwd);
		const coverage = normalizeCoverage(options.coverage);
		const evidence = this.getSessionEvidence(sessionId, cwd);
		const previous = evidence.get(normalized);
		evidence.set(
			normalized,
			mergeEvidence(
				previous || {
					kind: "read",
					fingerprint,
					coverage: { complete: false, ranges: [] },
					provenance: options.provenance || "read",
					searchHits: options.searchHits,
				},
				fingerprint,
				"read",
				coverage,
				options.provenance || "read",
				options.query,
				options.searchHits,
			),
		);
		this.persistSessionState(sessionId, cwd);
	}

	/**
	 * Record a successful mutation performed by the session itself (e.g. through `edit` or `write`).
	 * Refreshes the session's fingerprint against the mutated file content on disk so sequential
	 * edits do not trigger spurious drift rejections, while adjusting or preserving coverage.
	 */
	public recordFileMutation(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
		content?: string | Buffer,
		options: {
			complete?: boolean;
			targetRanges?: EvidenceRange[];
			deltaLines?: number;
		} = {},
	): void {
		if (!filePath) return;
		const fingerprint = this.fingerprint(filePath, cwd, content);
		if (!fingerprint) return;
		const normalized = this.normalize(filePath, cwd);
		const evidence = this.getSessionEvidence(sessionId, cwd);
		const previous = evidence.get(normalized);

		const isComplete = options.complete ?? previous?.coverage?.complete ?? false;
		let updatedRanges = previous?.coverage?.ranges ? [...previous.coverage.ranges] : [];
		const deltaLines = options.deltaLines ?? 0;

		if (!isComplete && deltaLines !== 0 && options.targetRanges && options.targetRanges.length > 0) {
			const maxEditEnd = Math.max(...options.targetRanges.map((r) => r.endLine));
			updatedRanges = updatedRanges.map((r) => {
				if (r.startLine > maxEditEnd) {
					return {
						startLine: r.startLine + deltaLines,
						endLine: r.endLine + deltaLines,
					};
				}
				return r;
			});
		}

		let totalLines: number | undefined;
		if (content !== undefined) {
			totalLines =
				typeof content === "string"
					? content.split("\n").length
					: content.toString("utf8").split("\n").length;
		}

		evidence.set(normalized, {
			kind: "read",
			fingerprint,
			coverage: normalizeCoverage({
				complete: isComplete,
				ranges: isComplete ? [] : updatedRanges,
				...(totalLines !== undefined
					? { totalLines }
					: previous?.coverage?.totalLines !== undefined
						? { totalLines: previous.coverage.totalLines + deltaLines }
						: {}),
			}),
			provenance: "edit",
		});
		this.persistSessionState(sessionId, cwd);
	}

	/** Search results are weaker evidence and never authorize a mutation. */
	public recordFileSearched(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
		options: EvidenceOptions = {},
	): void {
		if (!filePath) return;
		const fingerprint = this.fingerprint(filePath, cwd);
		if (!fingerprint) return;
		const evidence = this.getSessionEvidence(sessionId, cwd);
		const normalized = this.normalize(filePath, cwd);
		const previous = evidence.get(normalized);
		if (previous?.kind === "read") return;
		const provenance = options.provenance || "search";
		evidence.set(
			normalized,
			mergeEvidence(
				previous || {
					kind: "search",
					fingerprint,
					coverage: { complete: false, ranges: [] },
					provenance,
				},
				fingerprint,
				"search",
				normalizeCoverage(options.coverage ?? { complete: false, ranges: [] }),
				provenance,
				options.query,
			),
		);
		this.persistSessionState(sessionId, cwd);
	}

	private recordShellEvidence(
		command: string,
		cwd: string,
		sessionId: string,
		files: string[],
		outputComplete: boolean,
		outputText = "",
	): void {
		const isGrepOrRg =
			/^\s*(?:grep|rg)(?:\.exe)?(?:\s|$)/i.test(command) ||
			/\b(grep|rg)\b/i.test(command);
		const isPaging = /\b(head|tail|sed)\b/i.test(command);
		const isCat = /\bcat\b/i.test(command);

		if (isCat) {
			for (const filePath of files) {
				try {
					if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
						const observedContent = fs.readFileSync(filePath, "utf8");
						if (
							(outputComplete && files.length === 1 && outputText === observedContent) ||
							outputText.trim() === observedContent.trim() ||
							outputText.includes(observedContent.trim())
						) {
							this.recordFileRead(filePath, sessionId, cwd, observedContent, {
								coverage: { complete: true, ranges: [] },
								provenance: "bash",
								query: command,
							});
						}
					}
				} catch (error) {
					kernelDebug(error);
				}
			}
		}

		let parsed: GrepParseOutput;
		if (isPaging) {
			parsed = parsePagingAndDiffOutput(command, outputText, files, cwd);
		} else {
			parsed = parseGrepOutput(outputText, files, cwd);
		}

		for (const [filePath, lineNumbers] of parsed.entries()) {
			const ranges = linesToRanges(lineNumbers);
			if (ranges.length > 0) {
				const hits = parsed.searchHits?.get(filePath);
				this.recordFileRead(filePath, sessionId, cwd, undefined, {
					coverage: { complete: false, ranges },
					provenance: "bash",
					query: command,
					searchHits: hits,
				});
			}
		}

		for (const filePath of files) {
			const evidence = this.getSessionEvidence(sessionId, cwd).get(this.normalize(filePath, cwd));
			if (!evidence) {
				this.recordFileSearched(filePath, sessionId, cwd, {
					coverage: { complete: false, ranges: [] },
					provenance: "bash",
					query: command,
				});
			}
		}
	}

	/** Record classified shell content-reader evidence after a successful result. */
	public recordCommandExecution(
		command: string,
		cwd = process.cwd(),
		sessionId: string,
		outputComplete = true,
		outputText = "",
	): string[] {
		const files = extractInspectedFilesFromCommand(command, cwd);
		const isCompound = /[|;&\n><]/.test(command);
		for (const subCommand of command.split(/[|;&\n]+/)) {
			const trimmed = subCommand.trim();
			if (!trimmed) continue;
			this.recordShellEvidence(
				trimmed,
				cwd,
				sessionId,
				extractInspectedFilesFromCommand(trimmed, cwd),
				outputComplete && !isCompound,
				outputText,
			);
		}
		// Also scan outputText for polyglot compiler/test traces across the
		// workspace. Paging/search output already has stricter attribution above;
		// feeding it into the generic grep parser would let synthetic `1:line`
		// text manufacture read evidence.
		const isPagingOrSearchOutput = /\b(head|tail|sed|grep|rg)\b/i.test(command);
		if (!isPagingOrSearchOutput) {
			const traces = parseGrepOutput(outputText, files, cwd);
			for (const [filePath, lineNumbers] of traces.entries()) {
				const ranges = linesToRanges(lineNumbers);
				if (ranges.length > 0) {
					this.recordFileRead(filePath, sessionId, cwd, undefined, {
						coverage: { complete: false, ranges },
						provenance: "bash",
						query: command,
					});
				}
			}
		}
		return files;
	}

	/**
	 * Check workspace containment and require a fresh native read before editing
	 * or overwriting an existing file when inspection enforcement is enabled.
	 * The workspace defaults to the current process directory when callers do
	 * not provide an explicit cwd.
	 */
	public checkReadPrecondition(
		filePath: string,
		operation: "edit" | "write",
		sessionId: string,
		cwd?: string,
		enforceInspection = true,
		targetRanges: EvidenceRange[] = [],
		searchBlocks: string[] = [],
	): { allowed: boolean; reason?: string; tier?: 1 | 2 } {
		if (!filePath) {
			return {
				allowed: false,
				reason: "[EPISTEMIC GUARD]: Invalid or empty file path.",
			};
		}

		const workspace = cwd || process.cwd();
		const resolvedPath = this.resolvePath(filePath, workspace);
		if (cwd !== undefined && !this.isWithinWorkspace(resolvedPath, workspace)) {
			return {
				allowed: false,
				reason: `[WORKSPACE BOUNDARY REJECTION]: Path '${filePath}' resolves outside the workspace '${workspace}'.`,
			};
		}

		let exists = false;
		try {
			exists = fs.existsSync(resolvedPath);
			if (exists && !fs.statSync(resolvedPath).isFile()) {
				return {
					allowed: false,
					reason: `[EPISTEMIC GUARD]: Target '${filePath}' is not a regular file.`,
				};
			}
		} catch (error) {
			return {
				allowed: false,
				reason: `[EPISTEMIC GUARD]: Could not inspect target '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		if (!exists && operation === "edit") {
			return {
				allowed: false,
				reason: `[EPISTEMIC GUARD]: Target '${filePath}' does not exist.`,
			};
		}

		// A new file has no prior contents to inspect. Containment still applies for write.
		if (!enforceInspection || !exists) return { allowed: true };

		const normalized = this.normalize(resolvedPath, workspace);
		const evidence = this.getSessionEvidence(sessionId, workspace).get(normalized);
		const relPath = (path.relative(workspace, resolvedPath) || filePath).replace(/\\/g, "/");

		// 1. Session inspection check
		if (!evidence) {
			return {
				allowed: false,
				reason: `[BLOCKED: Uninspected File] The agent has never inspected '${relPath}' in this session -> read({ path: "${relPath}" })`,
			};
		}

		// 2. Stale file drift check
		const currentFingerprint = this.fingerprint(resolvedPath, workspace);
		if (!currentFingerprint || currentFingerprint !== evidence.fingerprint) {
			return {
				allowed: false,
				reason: `[BLOCKED: Stale File Drift] File '${relPath}' changed on disk since last observed -> read({ path: "${relPath}" })`,
			};
		}

		// 3. Write operations require prior read or complete coverage
		if (operation === "write") {
			if (evidence.kind !== "read" && !evidence.coverage.complete) {
				return {
					allowed: false,
					reason: `[BLOCKED: Read before write -> read({ path: "${relPath}" })]`,
				};
			}
			return { allowed: true };
		}

		// 4. Edit operations: Per-Block Hybrid Authorization
		// Each block in a multi-block edit must independently satisfy either:
		// - Tier 1: its resolved target range is covered by visible read evidence, OR
		// - Tier 2: its search block is substantive (>=2 lines and >=35 chars, or >=50 chars).
		if (targetRanges && targetRanges.length > 0 && searchBlocks && searchBlocks.length === targetRanges.length) {
			let allCoveredByRead = true;
			let failingBlockIndex = -1;

			for (let i = 0; i < targetRanges.length; i++) {
				const range = targetRanges[i];
				const sb = searchBlocks[i];

				// Validate range integrity
				if (
					!range ||
					!Number.isFinite(range.startLine) ||
					!Number.isFinite(range.endLine) ||
					range.startLine < 1 ||
					range.endLine < range.startLine ||
					(evidence.coverage.totalLines !== undefined && range.endLine > evidence.coverage.totalLines)
				) {
					return {
						allowed: false,
						reason: `[BLOCKED: Malformed or out-of-bounds target range in block ${i + 1}/${targetRanges.length} -> read({ path: "${relPath}" })]`,
					};
				}

				if (!sb || typeof sb !== "string" || sb.trim().length === 0) {
					return {
						allowed: false,
						reason: `[BLOCKED: Empty search block in block ${i + 1}/${targetRanges.length} -> read({ path: "${relPath}" })]`,
					};
				}

				const isCovered = coversRanges(evidence.coverage, [range]);
				let isAuthorized = isCovered;

				// Tier 1.5: Verified Search Overlap
				if (!isAuthorized && evidence.searchHits && evidence.searchHits.length > 0) {
					const overlappingHit = evidence.searchHits.find(
						(h) => h.line >= range.startLine && h.line <= range.endLine,
					);
					if (overlappingHit) {
						const linesBefore = overlappingHit.line - range.startLine;
						const linesAfter = range.endLine - overlappingHit.line;
						const totalLines = range.endLine - range.startLine + 1;
						if (linesBefore <= 3 && linesAfter <= 3 && totalLines <= 10) {
							isAuthorized = true;
						}
					}
				}

				// Bounded Micro-Hydration for adjacent edits (within 2 lines of an observed search hit)
				if (!isAuthorized && evidence.searchHits && evidence.searchHits.length > 0) {
					const adjacentHit = evidence.searchHits.find(
						(h) =>
							Math.abs(range.startLine - h.line) <= 2 ||
							Math.abs(range.endLine - h.line) <= 2,
					);
					const totalLines = range.endLine - range.startLine + 1;
					if (adjacentHit && totalLines <= 5) {
						try {
							evidence.coverage = mergeCoverage(evidence.coverage, {
								complete: false,
								ranges: [range],
							});
							isAuthorized = true;
						} catch {}
					}
				}

				if (!isAuthorized) {
					allCoveredByRead = false;
					const contentLines = sb.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
					const totalSubstantiveChars = contentLines.reduce((sum, line) => sum + line.trim().length, 0);
					const isSubstantive = contentLines.length >= 2 && totalSubstantiveChars >= 35;
					if (!isSubstantive) {
						failingBlockIndex = i;
						break;
					}
				}
			}

			if (failingBlockIndex === -1) {
				return { allowed: true, tier: allCoveredByRead ? 1 : 2 };
			}

			const failRange = targetRanges[failingBlockIndex];
			const maxAvailable = evidence.coverage.totalLines !== undefined
				? Math.max(1, evidence.coverage.totalLines - failRange.startLine + 1)
				: Math.max(15, failRange.endLine - failRange.startLine + 5);
			const hintLimit = Math.min(Math.max(15, failRange.endLine - failRange.startLine + 5), maxAvailable);
			return {
				allowed: false,
				reason: `[BLOCKED: Target lines not covered by visible read and search block is non-substantive (<2 lines / <35 chars) -> read({ path: "${relPath}", offset: ${failRange.startLine}, limit: ${hintLimit} })]`,
			};
		}

		// Tier 1: Strict range coverage
		if (evidence.kind === "read" && coversRanges(evidence.coverage, targetRanges)) {
			return { allowed: true, tier: 1 };
		}

		// Tier 1.5: Verified Search Overlap on single range
		if (
			evidence.kind === "read" &&
			targetRanges.length === 1 &&
			evidence.searchHits &&
			evidence.searchHits.length > 0
		) {
			const range = targetRanges[0];
			const overlappingHit = evidence.searchHits.find(
				(h) => h.line >= range.startLine && h.line <= range.endLine,
			);
			if (overlappingHit) {
				const linesBefore = overlappingHit.line - range.startLine;
				const linesAfter = range.endLine - overlappingHit.line;
				const totalLines = range.endLine - range.startLine + 1;
				if (linesBefore <= 3 && linesAfter <= 3 && totalLines <= 10) {
					return { allowed: true, tier: 1 };
				}
			}
		}

		// Search metadata is useful for navigation but never authorizes mutation,
		// regardless of how substantial the proposed replacement text is.
		if (evidence.kind !== "read") {
			return {
				allowed: false,
				reason: `[BLOCKED: Search metadata does not authorize edits -> read({ path: "${relPath}" })]`,
			};
		}

		// Tier 2: Substantive unique block authorization
		// If range math has gaps (e.g. grep context, compiler traces, symbol extraction boundaries),
		// authorize if every search block is substantive (>=2 non-empty content lines and >=35 chars).
		if (searchBlocks && searchBlocks.length > 0) {
			const allSubstantive = searchBlocks.every((sb) => {
				const contentLines = sb.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
				const totalSubstantiveChars = contentLines.reduce((sum, line) => sum + line.trim().length, 0);
				return contentLines.length >= 2 && totalSubstantiveChars >= 35;
			});

			if (allSubstantive) {
				return { allowed: true, tier: 2 };
			}

			return {
				allowed: false,
				reason: `[BLOCKED: Target lines not covered by visible read and search block is non-substantive (<2 lines / <35 chars) -> read({ path: "${relPath}" })]`,
			};
		}

		return {
			allowed: false,
			reason: `[BLOCKED: Target lines not covered by visible read -> read({ path: "${relPath}" })]`,
		};
	}

	/** Check whether the current session has any inspection evidence for a file. */
	public isFileInspected(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
	): boolean {
		return this.getSessionEvidence(sessionId, cwd).has(this.normalize(filePath, cwd));
	}

	public restoreEvidence(
		filePath: string,
		sessionId: string,
		evidence: ContextEvidence | null,
		cwd = process.cwd(),
	): void {
		const normalized = this.normalize(filePath, cwd);
		const sessionEvidence = this.inspectedFilesBySession.get(sessionId);
		if (!sessionEvidence) return;
		if (!evidence) {
			sessionEvidence.delete(normalized);
			return;
		}
		sessionEvidence.set(normalized, {
			kind: evidence.kind,
			fingerprint: evidence.snapshot,
			coverage: {
				complete: evidence.coverage.complete,
				ranges: evidence.coverage.ranges.map((range) => ({ ...range })),
				...(evidence.coverage.totalLines === undefined
					? {}
					: { totalLines: evidence.coverage.totalLines }),
			},
			provenance: evidence.provenance,
			...(evidence.query === undefined ? {} : { query: evidence.query }),
			...(evidence.searchHits ? { searchHits: [...evidence.searchHits] } : {}),
		});
		this.persistSessionState(sessionId, cwd);
	}

	/** Return a stable, non-content ledger view for diagnostics and tests. */
	public getEvidence(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
	): ContextEvidence | null {
		const normalized = this.normalize(filePath, cwd);
		const evidence = this.getSessionEvidence(sessionId, cwd).get(normalized);
		if (!evidence) return null;
		return {
			sessionId,
			filePath: normalized,
			kind: evidence.kind,
			snapshot: evidence.fingerprint,
			coverage: {
				complete: evidence.coverage.complete,
				ranges: evidence.coverage.ranges.map((range) => ({ ...range })),
				...(evidence.coverage.totalLines === undefined
					? {}
					: { totalLines: evidence.coverage.totalLines }),
			},
			provenance: evidence.provenance,
			...(evidence.query === undefined ? {} : { query: evidence.query }),
			...(evidence.searchHits ? { searchHits: [...evidence.searchHits] } : {}),
		};
	}

	public getInspectedFiles(sessionId: string, cwd = process.cwd()): string[] {
		return Array.from(this.getSessionEvidence(sessionId, cwd).keys());
	}

	public resetSession(sessionId: string): void {
		this.inspectedFilesBySession.delete(sessionId);
	}

	public purgeSession(sessionId: string, cwd = process.cwd()): void {
		this.inspectedFilesBySession.delete(sessionId);
		try {
			const filePath = getInspectionStateFilePath(sessionId, cwd);
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {}
	}

	public reset(): void {
		this.inspectedFilesBySession.clear();
	}
}

export const globalEpistemicGuard = new EpistemicGuard();
