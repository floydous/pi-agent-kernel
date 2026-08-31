/**
 * Epistemic Read-Before-Write Guard
 *
 * Enforces the cognitive invariant that an agent must inspect and ground itself
 * in real file contents before attempting to mutate code.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
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
		.replace(/\.exe$/, "");
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
				const resolved = path.isAbsolute(token) ? token : path.resolve(cwd, token);
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

interface InspectionEvidence {
	kind: "read" | "search";
	fingerprint: string;
}

export class EpistemicGuard {
	private inspectedFilesBySession: Map<string, Map<string, InspectionEvidence>> =
		new Map();

	private resolvePath(filePath: string, cwd = process.cwd()): string {
		return path.isAbsolute(filePath)
			? path.resolve(filePath)
			: path.resolve(cwd, filePath);
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
	private isWithinWorkspace(filePath: string, cwd: string): boolean {
		try {
			const isWindows = process.platform === "win32";
			const root = path.normalize(this.canonicalPath(path.resolve(cwd)));
			const target = path.normalize(
				this.canonicalPath(this.resolvePath(filePath, cwd)),
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
	): void {
		if (!filePath) return;
		const fingerprint = this.fingerprint(filePath, cwd, content);
		if (!fingerprint) return;
		this.getSessionEvidence(sessionId).set(this.normalize(filePath, cwd), {
			kind: "read",
			fingerprint,
		});
	}

	/** Search results are weaker evidence and never authorize a mutation. */
	public recordFileSearched(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
	): void {
		if (!filePath) return;
		const fingerprint = this.fingerprint(filePath, cwd);
		if (!fingerprint) return;
		const evidence = this.getSessionEvidence(sessionId);
		const normalized = this.normalize(filePath, cwd);
		if (evidence.get(normalized)?.kind !== "read") {
			evidence.set(normalized, { kind: "search", fingerprint });
		}
	}

	private recordShellEvidence(
		command: string,
		cwd: string,
		sessionId: string,
		files: string[],
	): void {
		const isSearch = /^\s*(?:grep|rg)(?:\.exe)?(?:\s|$)/i.test(command);
		for (const filePath of files) {
			if (isSearch) {
				this.recordFileSearched(filePath, sessionId, cwd);
			} else {
				this.recordFileRead(filePath, sessionId, cwd);
			}
		}
	}

	/** Record classified shell content-reader evidence during tool-call preflight. */
	public recordCommandExecution(
		command: string,
		cwd = process.cwd(),
		sessionId: string,
	): string[] {
		const files = extractInspectedFilesFromCommand(command, cwd);
		for (const subCommand of command.split(/[|;&\n]+/)) {
			const trimmed = subCommand.trim();
			if (!trimmed) continue;
			this.recordShellEvidence(
				trimmed,
				cwd,
				sessionId,
				extractInspectedFilesFromCommand(trimmed, cwd),
			);
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
	): { allowed: boolean; reason?: string } {
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

		// A new file has no prior contents to inspect. Containment still applies.
		if (!enforceInspection || !exists) return { allowed: true };

		const normalized = this.normalize(resolvedPath, workspace);
		const evidence = this.getSessionEvidence(sessionId).get(normalized);
		const relPath = path.relative(workspace, resolvedPath) || filePath;
		if (!evidence || evidence.kind !== "read") {
			return {
				allowed: false,
				reason: `[BLOCKED: Read before ${operation} -> read({ path: "${relPath}" })]`,
			};
		}

		const currentFingerprint = this.fingerprint(resolvedPath, workspace);
		if (!currentFingerprint || currentFingerprint !== evidence.fingerprint) {
			return {
				allowed: false,
				reason: `[BLOCKED: File changed since read -> read({ path: "${relPath}" })]`,
			};
		}

		return { allowed: true };
	}

	/** Check whether the current session has any inspection evidence for a file. */
	public isFileInspected(
		filePath: string,
		sessionId: string,
		cwd = process.cwd(),
	): boolean {
		return this.getSessionEvidence(sessionId).has(this.normalize(filePath, cwd));
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
