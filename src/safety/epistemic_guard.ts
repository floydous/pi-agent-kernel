/**
 * Epistemic Read-Before-Write Guard
 *
 * Enforces the cognitive invariant that an agent must inspect and ground itself
 * in real file AST tokens before attempting to mutate code.
 * Prevents ungrounded hallucination loops and J-space attention drift.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { kernelDebug } from "./kernel_debug";

/**
 * Extract file paths used as inputs by known shell content-reader commands.
 * This is command-shape evidence recorded during tool-call preflight; it does
 * not claim that a shell command produced output or that the agent understood it.
 * Search modes that emit only counts, filenames, or status are excluded.
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
		.replace(/\.exe$/, "");
}

export function extractInspectedFilesFromCommand(
	command: string,
	cwd: string = process.cwd(),
): string[] {
	if (!command || typeof command !== "string") return [];

	const inspected: string[] = [];

	// Split by pipelines, subshells, logical AND/OR, and statement separators
	const subCommands = command.split(/[|;&\n]+/);

	for (const sub of subCommands) {
		const trimmed = sub.trim();
		if (!trimmed) continue;

		// Regex to tokenize command respecting single and double quotes
		const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
		const tokens: string[] = [];
		let match: RegExpExecArray | null;

		while ((match = regex.exec(trimmed)) !== null) {
			let token = match[0].trim();
			// Strip outer quotes
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

		// Count, quiet, and filename-only search modes do not expose file
		// contents. Treat long and combined short options as non-inspection
		// evidence while retaining ordinary grep/rg output.
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

		const candidates: string[] = [];
		const positional = tokens.slice(1).filter((token) => {
			return (
				!token.startsWith("-") && ![">", ">>", "<", "2>", "2>&1"].includes(token)
			);
		});

		if (command === "grep" || command === "rg" || command === "awk") {
			// The first positional argument is the pattern/program; only later
			// positional arguments can be files.
			candidates.push(...positional.slice(1));
		} else if (command === "sed") {
			// sed's first positional argument is its editing script.
			candidates.push(...positional.slice(1));
		} else {
			candidates.push(...positional);
		}

		for (const tok of candidates) {
			try {
				const resolved = path.isAbsolute(tok) ? tok : path.resolve(cwd, tok);
				if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
					inspected.push(resolved);
				}
			} catch (e) {
				kernelDebug(e);
			}
		}
	}

	return Array.from(new Set(inspected));
}

export class EpistemicGuard {
	// Per-session inspection sets. Keyed by session id (or "__default__" for
	// CLI single-session use, or in-memory sessions that have no UUID).
	// This prevents cross-session contamination in RPC mode where one Node
	// process hosts multiple concurrent sessions.
	private inspectedFilesBySession: Map<string, Set<string>> = new Map();

	/**
	 * Normalize a file path for consistent tracking across relative/absolute forms.
	 *
	 * On Windows (case-insensitive filesystem), also lowercases so `Auth.ts` and
	 * `auth.ts` are recognized as the same file. On Linux and macOS, preserves case
	 * so the guard doesn't issue a false-positive rejection for a file the model
	 * legitimately read with a different case.
	 */
	private normalize(filePath: string): string {
		const isWin = process.platform === "win32";
		try {
			const resolved = path.isAbsolute(filePath)
				? filePath
				: path.resolve(process.cwd(), filePath);
			const norm = path.normalize(resolved);
			return isWin ? norm.toLowerCase() : norm;
		} catch {
			const norm = path.normalize(filePath);
			return isWin ? norm.toLowerCase() : norm;
		}
	}

	/**
	 * Get or create the inspection set for a given session id.
	 */
	private getSessionSet(sessionId: string): Set<string> {
		let set = this.inspectedFilesBySession.get(sessionId);
		if (!set) {
			set = new Set();
			this.inspectedFilesBySession.set(sessionId, set);
		}
		return set;
	}

	/**
	 * Record that a file's contents were exposed by a native reader or symbol reader.
	 */
	public recordFileRead(filePath: string, sessionId: string): void {
		if (!filePath) return;
		const norm = this.normalize(filePath);
		this.getSessionSet(sessionId).add(norm);
	}

	/**
	 * Record that a file was returned by AST or vector search.
	 * Search results are treated as inspection evidence for edit compatibility.
	 */
	public recordFileSearched(filePath: string, sessionId: string): void {
		if (!filePath) return;
		const norm = this.normalize(filePath);
		this.getSessionSet(sessionId).add(norm);
	}

	/**
	 * Record files used by classified shell content-reader commands.
	 * This runs during tool-call preflight so same-batch shell-read/edit behavior
	 * remains compatible; result output is not available at this point.
	 */
	public recordCommandExecution(
		command: string,
		cwd: string = process.cwd(),
		sessionId: string,
	): string[] {
		const files = extractInspectedFilesFromCommand(command, cwd);
		for (const f of files) {
			this.recordFileRead(f, sessionId);
		}
		return files;
	}

	/**
	 * Check if a mutation operation (edit/write) satisfies the Read-Before-Write precondition.
	 */
	public checkReadPrecondition(
		filePath: string,
		operation: "edit" | "write",
		sessionId: string,
	): { allowed: boolean; reason?: string } {
		if (!filePath) {
			return {
				allowed: false,
				reason: "[EPISTEMIC GUARD]: Invalid or empty file path.",
			};
		}

		const resolvedPath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(process.cwd(), filePath);

		const exists = fs.existsSync(resolvedPath);

		// If writing a brand-new file that does not exist, allow creation directly
		if (operation === "write" && !exists) {
			return { allowed: true };
		}

		// If editing or overwriting an existing file, verify it has been inspected first
		const norm = this.normalize(filePath);
		if (exists && !this.getSessionSet(sessionId).has(norm)) {
			return {
				allowed: false,
				reason:
					`[EPISTEMIC GUARD REJECTION]: File '${filePath}' must be inspected before editing.\n` +
					`You must ground your attention in the physical file contents first.\n` +
					`Action required: Invoke read({ path: "${filePath}", symbol: "..." }) or read the file before calling ${operation}.`,
			};
		}

		return { allowed: true };
	}

	/**
	 * Check if a specific file has been inspected.
	 */
	public isFileInspected(filePath: string, sessionId: string): boolean {
		return this.getSessionSet(sessionId).has(this.normalize(filePath));
	}

	/**
	 * Get the list of all files inspected in the current session.
	 */
	public getInspectedFiles(sessionId: string): string[] {
		return Array.from(this.getSessionSet(sessionId));
	}

	/**
	 * Reset inspection tracking for a single session. Called from session_shutdown
	 * to bound memory growth across long-lived processes hosting many sessions.
	 */
	public resetSession(sessionId: string): void {
		this.inspectedFilesBySession.delete(sessionId);
	}

	/**
	 * Reset inspection tracking for ALL sessions. Use sparingly; prefer resetSession.
	 */
	public reset(): void {
		this.inspectedFilesBySession.clear();
	}
}

// Global Singleton Instance
export const globalEpistemicGuard = new EpistemicGuard();
