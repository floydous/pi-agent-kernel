import * as fs from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";

export const DEFAULT_IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	"dist",
	"build",
	"coverage",
	".pi",
	".hermes",
	".next",
	".turbo",
	".cache",
	"target",
	"vendor",
	"agent-kernel-benchmark",
]);

export interface IgnoreFrame {
	dirRel: string; // relative to baseRoot with forward slashes (empty string for baseRoot)
	ig: Ignore;
}

/**
 * Finds the enclosing git root containing startDir, if any.
 */
export function findGitRoot(startDir: string): string | null {
	let curr = path.resolve(startDir);
	while (true) {
		if (fs.existsSync(path.join(curr, ".git"))) {
			return curr;
		}
		const parent = path.dirname(curr);
		if (parent === curr) break;
		curr = parent;
	}
	return null;
}

/**
 * Creates an ignore instance from a file path if the file exists.
 */
export function loadIgnoreFile(filePath: string): Ignore | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const ignoreFn = typeof ignore === "function" ? ignore : (ignore as { default?: () => Ignore }).default;
		if (typeof ignoreFn !== "function") return null;
		const ig = ignoreFn();
		return ig.add(content);
	} catch {
		return null;
	}
}

/**
 * Checks whether a path (relative to baseRoot, with forward slashes) is ignored
 * according to the stack of IgnoreFrames (evaluated from deepest child to root).
 */
export function isPathIgnored(stack: IgnoreFrame[], relPath: string, isDirectory: boolean): boolean {
	const targetPath = isDirectory && !relPath.endsWith("/") ? relPath + "/" : relPath;
	for (let i = stack.length - 1; i >= 0; i--) {
		const frame = stack[i];
		let relToFrame = frame.dirRel ? targetPath.slice(frame.dirRel.length + 1) : targetPath;
		if (relToFrame.startsWith("/")) relToFrame = relToFrame.slice(1);
		if (!relToFrame) continue;

		// SAFETY: the 'ignore' library instance provides .test() returning { ignored, unignored }
		// which is omitted from older @types/ignore declarations.
		const res = (frame.ig as unknown as { test: (p: string) => { ignored: boolean; unignored: boolean } }).test(relToFrame);
		if (res.unignored) return false;
		if (res.ignored) return true;
	}
	return false;
}

export interface WalkWorkspaceOptions {
	rootDir: string;
	maxFiles?: number;
	extensions?: Set<string>;
	includeGithub?: boolean;
	onFile?: (filePath: string) => boolean | void;
	/** Called for each directory whose ignore files are consulted, before it is read. */
	onDirectory?: (dirPath: string) => void;
}

/**
 * Walks workspace directories recursively respecting .gitignore, additive .piignore,
 * and built-in hard exclusions (DEFAULT_IGNORED_DIRS).
 *
 * Safety boundaries:
 * 1. Hard exclusions (DEFAULT_IGNORED_DIRS) cannot be overridden by user negations.
 * 2. Gitignore hierarchy (nested .gitignore overrides parent .gitignore).
 * 3. Additive .piignore (can only add exclusions; cannot un-ignore Git-ignored files).
 * 4. Symlinks & containment: Symbolic links are skipped; traversed directories must remain
 *    strictly bounded inside the canonical workspace root.
 * 5. Parent scope inheritance: When rootDir is a subdirectory of a Git repository, parent
 *    .gitignore files from gitRoot down to rootDir are discovered and applied in order.
 *
 * Returns absolute paths to matching files.
 */
export function walkWorkspaceFiles(options: WalkWorkspaceOptions): string[] {
	const rootDir = path.resolve(options.rootDir);
	const maxFiles = options.maxFiles ?? 500;
	const extensions = options.extensions;
	const includeGithub = options.includeGithub ?? true;
	const files: string[] = [];

	let canonicalRoot: string;
	try {
		canonicalRoot = fs.realpathSync(rootDir);
	} catch {
		canonicalRoot = rootDir;
	}

	const visitedDirs = new Set<string>();
	visitedDirs.add(canonicalRoot);

	// Resolve Git base root (to support starting at subdirectories)
	const gitRoot = findGitRoot(rootDir);
	const baseRoot = gitRoot ? path.resolve(gitRoot) : rootDir;

	// Build initial ignore stacks from baseRoot down to rootDir
	const rootGitFrames: IgnoreFrame[] = [];
	const rootPiFrames: IgnoreFrame[] = [];

	// Collect directories in the path from baseRoot down to rootDir
	const initialDirs: string[] = [];
	let curr = rootDir;
	while (curr.startsWith(baseRoot)) {
		initialDirs.unshift(curr);
		if (curr === baseRoot) break;
		const parent = path.dirname(curr);
		if (parent === curr) break;
		curr = parent;
	}

	for (const dir of initialDirs) {
		options.onDirectory?.(dir);
		const dirRel = path.relative(baseRoot, dir).replace(/\\/g, "/");
		const localGit = loadIgnoreFile(path.join(dir, ".gitignore"));
		if (localGit) {
			rootGitFrames.push({ dirRel, ig: localGit });
		}
		const localPi = loadIgnoreFile(path.join(dir, ".piignore"));
		if (localPi) {
			rootPiFrames.push({ dirRel, ig: localPi });
		}
	}

	function scan(dir: string, gitStack: IgnoreFrame[], piStack: IgnoreFrame[]): boolean {
		if (files.length >= maxFiles) return false;

		options.onDirectory?.(dir);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return true;
		}

		// Check for local directory .gitignore / .piignore when below rootDir
		const currentGitStack = [...gitStack];
		const currentPiStack = [...piStack];
		const dirRel = path.relative(baseRoot, dir).replace(/\\/g, "/");

		// If dir is not one of the preloaded initialDirs, load local ignore files
		if (!initialDirs.includes(dir)) {
			const localGitIgnore = loadIgnoreFile(path.join(dir, ".gitignore"));
			if (localGitIgnore) {
				currentGitStack.push({ dirRel, ig: localGitIgnore });
			}
			const localPiIgnore = loadIgnoreFile(path.join(dir, ".piignore"));
			if (localPiIgnore) {
				currentPiStack.push({ dirRel, ig: localPiIgnore });
			}
		}

		for (const entry of entries) {
			if (files.length >= maxFiles) return false;

			// Skip symbolic links to prevent circular loops or out-of-tree escapes
			if (entry.isSymbolicLink()) {
				continue;
			}

			// Handle hidden files/folders: ignore unless .github is explicitly permitted
			if (entry.name.startsWith(".")) {
				if (!includeGithub || entry.name !== ".github") {
					continue;
				}
			}

			// Built-in hard exclusions (cannot be negated)
			if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
				continue;
			}

			const fullPath = path.join(dir, entry.name);
			const entryRel = path.relative(baseRoot, fullPath).replace(/\\/g, "/");

			if (entry.isDirectory()) {
				let realDir: string;
				try {
					realDir = fs.realpathSync(fullPath);
				} catch {
					// Dangling link or permission error; safely skip
					continue;
				}

				// Symlink & workspace containment guard
				const relToRoot = path.relative(canonicalRoot, realDir);
				if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
					continue;
				}

				if (visitedDirs.has(realDir)) {
					continue;
				}

				// Test directory ignore against .gitignore then .piignore
				if (
					isPathIgnored(currentGitStack, entryRel, true) ||
					isPathIgnored(currentPiStack, entryRel, true)
				) {
					continue;
				}

				visitedDirs.add(realDir);
				const shouldContinue = scan(fullPath, currentGitStack, currentPiStack);
				if (!shouldContinue) return false;
			} else if (entry.isFile()) {
				// Extension filtering
				if (extensions) {
					const ext = path.extname(entry.name).toLowerCase();
					if (!extensions.has(ext)) {
						continue;
					}
				}

				// Check .gitignore first
				if (isPathIgnored(currentGitStack, entryRel, false)) {
					continue;
				}

				// Check additive .piignore second
				if (isPathIgnored(currentPiStack, entryRel, false)) {
					continue;
				}

				files.push(fullPath);
				if (options.onFile) {
					const cont = options.onFile(fullPath);
					if (cont === false) return false;
				}
			}
		}

		return true;
	}

	scan(rootDir, rootGitFrames, rootPiFrames);
	return files;
}

interface WalkProbe {
	path: string;
	/** `.git` probes only matter for existence: git operations touch .git constantly. */
	existenceOnly: boolean;
	stats?: fs.Stats;
}

const WALK_RACY_WINDOW_MS = 2_000;

function takeProbe(probePath: string, existenceOnly: boolean): WalkProbe {
	return { path: probePath, existenceOnly, stats: fs.statSync(probePath, { throwIfNoEntry: false }) };
}

function probeUnchanged(probe: WalkProbe): boolean {
	const now = fs.statSync(probe.path, { throwIfNoEntry: false });
	if (!probe.stats || !now) return !probe.stats && !now;
	if (probe.existenceOnly) return true;
	return probe.stats.dev === now.dev && probe.stats.ino === now.ino && probe.stats.size === now.size
		&& probe.stats.mtimeMs === now.mtimeMs && probe.stats.isDirectory() === now.isDirectory();
}

/**
 * Reuses a workspace walk until something it depended on changes: a visited directory (entry
 * add/remove/rename updates its mtime), a consulted .gitignore/.piignore, or the `.git` ancestors
 * that decide the ignore root. Walks recorded within the mtime-granularity window are not reused.
 */
export class WorkspaceWalkCache {
	private key = "";
	private files: string[] = [];
	private probes: WalkProbe[] = [];
	private racy = true;

	walk(options: WalkWorkspaceOptions): string[] {
		if (options.onFile) return walkWorkspaceFiles(options);
		const key = JSON.stringify([
			path.resolve(options.rootDir),
			options.maxFiles ?? 500,
			options.includeGithub ?? true,
			options.extensions ? [...options.extensions].sort() : null,
		]);
		if (key === this.key && !this.racy && this.probes.every(probeUnchanged)) return this.files.slice();

		const started = Date.now();
		const probes = new Map<string, WalkProbe>();
		const record = (probePath: string, existenceOnly = false) => {
			if (!probes.has(probePath)) probes.set(probePath, takeProbe(probePath, existenceOnly));
		};
		for (let dir = path.resolve(options.rootDir); ; dir = path.dirname(dir)) {
			record(path.join(dir, ".git"), true);
			if (probes.get(path.join(dir, ".git"))!.stats || path.dirname(dir) === dir) break;
		}
		const files = walkWorkspaceFiles({
			...options,
			onDirectory: (dir) => {
				options.onDirectory?.(dir);
				record(dir);
				record(path.join(dir, ".gitignore"));
				record(path.join(dir, ".piignore"));
			},
		});
		this.key = key;
		this.files = files;
		this.probes = [...probes.values()];
		this.racy = this.probes.some((p) => !p.existenceOnly && p.stats && p.stats.mtimeMs >= started - WALK_RACY_WINDOW_MS);
		return files.slice();
	}
}
