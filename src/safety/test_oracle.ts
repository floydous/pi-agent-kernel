/**
 * Deterministic Test & Contract Oracle
 *
 * Implements external deterministic evaluation (DeepMind Verifier Principle):
 * Evaluates binary exit codes, type checks, and test runner outputs to establish
 * indisputable [VERIFIED] ground truth without relying on LLM self-reflection.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clampCommandOutput } from "./output_clamper";
import { kernelDebug } from "./kernel_debug";

export interface OracleExecutionResult {
	passed: boolean;
	exitCode: number;
	durationMs: number;
	output: string;
	rawLength: number;
	spilloverPath?: string;
	summary: string;
}

/**
 * Execute a test command or validation script and deterministically evaluate the result.
 *
 * NOTE: `command` is executed through the system shell BY DESIGN — this is an
 * explicitly user-invoked escape hatch (`/oracle <cmd>`) where shell features
 * (pipes, &&, env vars) are part of the contract. It runs with the user's own
 * privileges on their own machine; it is not exposed to untrusted input.
 */
export async function runOracle(
	command: string,
	options: {
		cwd?: string;
		timeoutMs?: number;
		maxLines?: number;
		maxLineLength?: number;
	} = {},
): Promise<OracleExecutionResult> {
	const cwd = options.cwd || process.cwd();
	const timeout = options.timeoutMs || 30000;
	const startTime = Date.now();
	const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB, mirrors the old exec maxBuffer

	return new Promise<OracleExecutionResult>((resolve) => {
		// detached:true makes the child a process-group leader on POSIX so the
		// whole shell subtree can be killed; on Windows we use `taskkill /T`.
		const child = child_process.spawn(command, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
			detached: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let capturedBytes = 0;
		let settled = false;

		const collect = (chunk: Buffer, sink: "out" | "err") => {
			if (capturedBytes >= MAX_BUFFER) return; // keep draining, stop storing
			capturedBytes += chunk.length;
			if (sink === "out") stdout += chunk.toString();
			else stderr += chunk.toString();
		};

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			const durationMs = Date.now() - startTime;
			const rawStdout = stdout || "";
			const rawStderr = stderr || "";
			const combined = (
				rawStdout + (rawStderr ? `\n--- STDERR ---\n${rawStderr}` : "")
			).trim();

			// `code` is null when the process was killed (e.g. timeout) or could not spawn.
			const exitCode = typeof code === "number" ? code : 1;
			const passed = exitCode === 0;

			// Clamp output to protect context window while saving full logs
			const clamped = clampCommandOutput(combined, command, {
				maxLines: options.maxLines || 60,
				maxLineLength: options.maxLineLength || 300,
				maxTotalBytes: 30 * 1024,
			});

			const statusText = passed ? "GREEN [VERIFIED]" : `RED [EXIT ${exitCode}]`;
			const summary = `Oracle Result: ${statusText} | Command: '${command}' | Duration: ${durationMs}ms`;

			resolve({
				passed,
				exitCode,
				durationMs,
				output: clamped.text,
				rawLength: clamped.originalBytes,
				spilloverPath: clamped.spilloverPath,
				summary,
			});
		};
		child.stdout?.on("data", (c: Buffer) => collect(c, "out"));
		child.stderr?.on("data", (c: Buffer) => collect(c, "err"));

		// Kill the ENTIRE process tree on timeout. Node's built-in `timeout`
		// option only signals the direct child (the shell), which does not
		// terminate grandchildren (e.g. a long-running test runner) — notably
		// on Windows, where killing cmd.exe leaves children running.
		const killer = setTimeout(() => {
			try {
				if (process.platform === "win32" && child.pid) {
					child_process.execFileSync(
						"taskkill",
						["/pid", String(child.pid), "/T", "/F"],
						{ stdio: "ignore" },
					);
				} else if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL"); // kill process group
					} catch {
						child.kill("SIGKILL");
					}
				}
			} catch (e) {
				kernelDebug(e);
			}
		}, timeout);

		child.on("close", (code) => {
			clearTimeout(killer);
			finish(code);
		});

		// Spawn failure (e.g. shell not found): close may never fire — resolve here.
		child.on("error", () => {
			clearTimeout(killer);
			finish(1);
		});
	});
}

/**
 * Run language-specific type checker oracle.
 */
export async function runTypeCheckOracle(
	cwd: string = process.cwd(),
): Promise<OracleExecutionResult> {
	const tsconfigPath = path.join(cwd, "tsconfig.json");
	if (fs.existsSync(tsconfigPath)) {
		return runOracle("npx --yes tsc --noEmit", { cwd, timeoutMs: 25000 });
	}

	// Python mypy/pyright fallback if pyproject or setup exists
	const pyprojectPath = path.join(cwd, "pyproject.toml");
	if (fs.existsSync(pyprojectPath)) {
		return runOracle("mypy .", { cwd, timeoutMs: 20000 });
	}

	return {
		passed: true,
		exitCode: 0,
		durationMs: 0,
		output: "No static type configuration detected (skipping type-check oracle).",
		rawLength: 0,
		summary: "Oracle: Type-check skipped (no tsconfig/pyproject)",
	};
}
