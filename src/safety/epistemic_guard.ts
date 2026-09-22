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

export interface EvidenceOptions {
	coverage?: EvidenceCoverage;
	provenance?: EvidenceProvenance;
	query?: string;
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
}

interface InspectionEvidence {
	kind: "read" | "search";
	fingerprint: string;
	coverage: EvidenceCoverage;
	provenance: EvidenceProvenance;
	query?: string;
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
): InspectionEvidence {
	if (previous.fingerprint !== fingerprint) {
		return {
			kind,
			fingerprint,
			coverage,
			provenance,
			...(query === undefined ? {} : { query }),
		};
	}
	// Once marked read, retain read kind unless reset
	const mergedKind = previous.kind === "read" || kind === "read" ? "read" : "search";
	return {
		...previous,
		kind: mergedKind,
		coverage: mergeCoverage(previous.coverage, coverage),
		provenance,
		...(query === undefined ? {} : { query }),
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

/** Parse stdout from grep / ripgrep, capturing file paths and line numbers. */
export function parseGrepOutput(
	outputText: string,
	candidateFiles: string[],
	cwd = process.cwd(),
): Map<string, number[]> {
	const fileLinesMap = new Map<string, Set<number>>();
	if (!outputText || typeof outputText !== "string") return new Map();

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
		const trimmed = line.trim();
		if (!trimmed) continue;

		// 1. Single file: "123:code" or "123-context"
		const singleMatch = line.match(/^(\d+)[:-]/);
		if (singleMatch && candidateFiles.length === 1) {
			const lineNum = parseInt(singleMatch[1], 10);
			const targetPath = normalizedCandidates.get(candidateFiles[0]) || path.resolve(cwd, candidateFiles[0]);
			if (!fileLinesMap.has(targetPath)) fileLinesMap.set(targetPath, new Set());
			fileLinesMap.get(targetPath)!.add(lineNum);
			continue;
		}

		// 2. Multi-file: "path/to/file.ts:123:code" or "path/to/file.ts-123-context"
		const multiMatch = line.match(/^([^:\-\n\r]+(?:\.[a-zA-Z0-9]+)?)(?::(\d+):|-(\d+)-)/);
		if (multiMatch) {
			const rawPath = multiMatch[1].trim();
			const lineNum = parseInt(multiMatch[2] || multiMatch[3], 10);
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
			line.match(/(?:-->|\s+at|\s+❯|File\s+["']?)\s*([^\s"(),]+\.[a-zA-Z0-9]+)(?:["']?)(?:[:(]|\s*,?\s*line\s+)(\d+)/i) ||
			line.match(/(?:^|[\s(])([^\s()]+\.[a-zA-Z0-9]+)[:(](\d+)(?:[:,\s)]|$)/);

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
			}
		}
	}

	const result = new Map<string, number[]>();
	for (const [file, set] of fileLinesMap.entries()) {
		result.set(file, Array.from(set).sort((a, b) => a - b));
	}
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
	if (candidateFiles.length === 0) return result;

	const targetPath = path.isAbsolute(candidateFiles[0])
		? path.normalize(candidateFiles[0])
		: path.resolve(cwd, candidateFiles[0]);

	let totalLines = 0;
	if (fs.existsSync(targetPath)) {
		try {
			totalLines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/).length;
		} catch {
			totalLines = 0;
		}
	}

	// 1. head -n <N>
	const headMatch = command.match(/\bhead\b.*?-n\s*(\d+)/i);
	if (headMatch) {
		const count = Math.min(parseInt(headMatch[1], 10), totalLines || 1000);
		const lines: number[] = [];
		for (let i = 1; i <= count; i++) lines.push(i);
		result.set(targetPath, lines);
		return result;
	}

	// 2. tail -n <N>
	const tailMatch = command.match(/\btail\b.*?-n\s*(\d+)/i);
	if (tailMatch) {
		const count = parseInt(tailMatch[1], 10);
		const start = Math.max(1, (totalLines || count) - count + 1);
		const end = totalLines || count;
		const lines: number[] = [];
		for (let i = start; i <= end; i++) lines.push(i);
		result.set(targetPath, lines);
		return result;
	}

	// 3. sed -n '<start>,<end>p'
	const sedMatch = command.match(/\bsed\b.*?-n\s*['"]?(\d+),(\d+)p['"]?/i);
	if (sedMatch) {
		const start = parseInt(sedMatch[1], 10);
		const end = parseInt(sedMatch[2], 10);
		const lines: number[] = [];
		for (let i = start; i <= end; i++) lines.push(i);
		result.set(targetPath, lines);
		return result;
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

	private getSessionEvidence(
		sessionId: string,
	): Map<string, InspectionEvidence> {
		let evidence = this.inspectedFilesBySession.get(sessionId);
		if (!evidence) {
			evidence = new Map();
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
		const evidence = this.getSessionEvidence(sessionId);
		const previous = evidence.get(normalized);
		evidence.set(
			normalized,
			mergeEvidence(
				previous || {
					kind: "read",
					fingerprint,
					coverage: { complete: false, ranges: [] },
					provenance: options.provenance || "read",
				},
				fingerprint,
				"read",
				coverage,
				options.provenance || "read",
				options.query,
			),
		);
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
		const evidence = this.getSessionEvidence(sessionId);
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
		const evidence = this.getSessionEvidence(sessionId);
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

		let parsed: Map<string, number[]>;
		if (isPaging) {
			parsed = parsePagingAndDiffOutput(command, outputText, files, cwd);
		} else {
			parsed = parseGrepOutput(outputText, files, cwd);
		}

		for (const [filePath, lineNumbers] of parsed.entries()) {
			const ranges = linesToRanges(lineNumbers);
			if (ranges.length > 0) {
				this.recordFileRead(filePath, sessionId, cwd, undefined, {
					coverage: { complete: false, ranges },
					provenance: "bash",
					query: command,
				});
			}
		}

		for (const filePath of files) {
			const evidence = this.getSessionEvidence(sessionId).get(this.normalize(filePath, cwd));
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
		// Also scan outputText for polyglot compiler/test traces across the workspace
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
		const evidence = this.getSessionEvidence(sessionId).get(normalized);
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

		// 4. Edit operations: Dual-Tier Authorization
		// Tier 1: Strict range coverage
		if (evidence.kind === "read" && coversRanges(evidence.coverage, targetRanges)) {
			return { allowed: true, tier: 1 };
		}

		// Tier 2: Substantive unique block authorization
		// If range math has gaps (e.g. grep context, compiler traces, symbol extraction boundaries),
		// authorize if every search block is substantive (>=2 lines and >=35 chars, or >=50 chars).
		if (searchBlocks && searchBlocks.length > 0) {
			const allSubstantive = searchBlocks.every((sb) => {
				const lineCount = sb.replace(/\r\n/g, "\n").split("\n").length;
				const charCount = sb.length;
				return (lineCount >= 2 && charCount >= 35) || charCount >= 50;
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
		return this.getSessionEvidence(sessionId).has(this.normalize(filePath, cwd));
	}

	/** Return a stable, non-content ledger view for diagnostics and tests. */
	public getEvidence(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
	): ContextEvidence | null {
		const normalized = this.normalize(filePath, cwd);
		const evidence = this.getSessionEvidence(sessionId).get(normalized);
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
		};
	}

	public getInspectedFiles(sessionId: string): string[] {
		return Array.from(this.getSessionEvidence(sessionId).keys());
	}

	public resetSession(sessionId: string): void {
		this.inspectedFilesBySession.delete(sessionId);
	}

	public reset(): void {
		this.inspectedFilesBySession.clear();
	}
}

export const globalEpistemicGuard = new EpistemicGuard();
