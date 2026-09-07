// Shared test setup utilities.
// Provides a temporary workspace and assertion helpers used by all
// section-XX-*.ts files in this directory.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getPolyglotFixture, POLYGLOT_FIXTURE_FILES } from "./polyglot_fixtures";

export interface TestWorkspace {
	tempDir: string;
	calculatorPath: string;
	mainPath: string;
	files: Map<string, string>;
	cleanup: () => void;
}

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "workspace");

function loadFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURE_ROOT, name), "utf8");
}

/**
 * Backwards-compat re-exports for tests that still reference the inline
 * constants. New code should call `loadFixture` directly to read from disk.
 */
export const PY_CODE = loadFixture("calculator.py");
export const MAIN_CODE = loadFixture("main.py");

/**
 * Create a fresh temporary workspace populated with the standard test
 * files. Each test that needs a workspace should call this at the top of
 * its `run()` function, so tests are fully independent.
 */
export function createTestWorkspace(
	prefix: string = "pi_kernel_test_",
): TestWorkspace {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const calculatorPath = path.join(tempDir, "calculator.py");
	const mainPath = path.join(tempDir, "main.py");
	fs.writeFileSync(calculatorPath, loadFixture("calculator.py"), "utf8");
	fs.writeFileSync(mainPath, loadFixture("main.py"), "utf8");

	const files = new Map<string, string>();
	files.set("calculator.py", calculatorPath);
	files.set("main.py", mainPath);

	return {
		tempDir,
		calculatorPath,
		mainPath,
		files,
		cleanup: () => {
			try {
				process.chdir(originalCwd);
			} catch {
				// Restore the test process directory before removing the workspace.
			}
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		},
	};
}

/**
 * Create a rich polyglot workspace populated with real source files committed
 * to the repository at tests/fixtures/polyglot/. This is purely a file copy
 * (no synthetic content generation), so reviewers can see the exact files
 * the production parsers will see.
 */
export function createPolyglotWorkspace(
	prefix: string = "pi_kernel_polyglot_",
): TestWorkspace {
	const ws = createTestWorkspace(prefix);

	for (const relPath of POLYGLOT_FIXTURE_FILES) {
		const fullPath = path.join(ws.tempDir, relPath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, getPolyglotFixture(relPath), "utf8");
		ws.files.set(relPath, fullPath);
	}

	return ws;
}

/**
 * Print a section header in the format used by the section runner.
 */
export function logSection(name: string): void {
	console.log(`[${name}]`);
}

/**
 * Custom error thrown by assertPass. Includes the failed label as its message
 * so the runner can identify which assertion failed.
 */
export class AssertionError extends Error {
	constructor(label: string, details?: unknown) {
		super(label);
		this.name = "AssertionError";
		if (details !== undefined) {
			(this as any).details = details;
		}
	}
}

/**
 * Assert a condition. If false, prints a labelled error to stderr and throws
 * an AssertionError. Throwing (instead of process.exit) lets the test runner
 * catch the failure and continue with other sections.
 */
export function assertPass(
	label: string,
	cond: boolean,
	details?: unknown,
): void {
	if (!cond) {
		console.error(`✗ ${label}`, details ?? "");
		throw new AssertionError(label, details);
	}
}

/**
 * Print a success line.
 */
export function logPass(label: string): void {
	console.log(`✓ ${label}`);
}

/**
 * Run a section function with consistent error handling.
 * If the section throws, the error is printed and the process exits 1.
 */
export async function runSection(
	name: string,
	fn: () => void | Promise<void>,
): Promise<void> {
	logSection(name);
	try {
		await fn();
	} catch (err) {
		console.error(`✗ Section ${name} threw:`, err);
		process.exitCode = 1;
		throw err;
	}
}
