// Shared test setup utilities.
// Provides a temporary workspace and assertion helpers used by all
// section-XX-*.ts files in this directory.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface TestWorkspace {
	tempDir: string;
	calculatorPath: string;
	mainPath: string;
	cleanup: () => void;
}

/**
 * The standard Python code used by workspace-dependent tests.
 * Provides the standard fixture shared by workspace-dependent sections.
 */
export const PY_CODE = `
class Calculator:
    def __init__(self, precision: int = 2):
        self.precision = precision

    def calculate_tax(self, subtotal: float) -> float:
        """Calculate tax based on subtotal."""
        return subtotal * 0.08

    def process_discount(self, subtotal: float, discount: float) -> float:
        return subtotal - discount
`;

export const MAIN_CODE = `from calculator import Calculator

def main():
    calc = Calculator()
    print(calc.calculate_tax(100.0))
`;

/**
 * Create a fresh temporary workspace populated with the standard test
 * files. Each test that needs a workspace should call this at the top of
 * its `run()` function, so tests are fully independent.
 */
export function createTestWorkspace(
	prefix: string = "pi_kernel_test_",
): TestWorkspace {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const calculatorPath = path.join(tempDir, "calculator.py");
	const mainPath = path.join(tempDir, "main.py");
	fs.writeFileSync(calculatorPath, PY_CODE, "utf8");
	fs.writeFileSync(mainPath, MAIN_CODE, "utf8");

	return {
		tempDir,
		calculatorPath,
		mainPath,
		cleanup: () => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		},
	};
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
