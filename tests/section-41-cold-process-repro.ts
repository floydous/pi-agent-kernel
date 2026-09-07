// Cold-process reproduction: spawns a fresh `tsx` subprocess for each
// language so that TreeSitter has not loaded any grammar yet, and the
// regex fallback path is exercised exactly as a real first user call
// would experience it.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createPolyglotWorkspace, logPass } from "./_setup";

interface TestCase {
	lang: string;
	relFile: string;
	expectedNames: string[];
	searchSymbol: string;
	searchKind: string;
}

const TEST_CASES: TestCase[] = [
	{
		lang: "TypeScript",
		relFile: "src/app.ts",
		expectedNames: ["withConnection", "connectInternal", "ping", "endpoint", "isActive", "release", "createDefault", "runMigrations", "start", "handleRequest", "getStats"],
		searchSymbol: "handleRequest",
		searchKind: "method",
	},
	{
		lang: "C#",
		relFile: "src/OrderProcessor.cs",
		expectedNames: ["InvoiceRecord", "InvoiceService", "GenerateAsync", "FindById", "MarkPaid"],
		searchSymbol: "FindById",
		searchKind: "method",
	},
	{
		lang: "C++",
		relFile: "src/solver.cpp",
		expectedNames: ["Matrix", "GeometrySolver", "at", "calculate_hypotenuse", "dot_product", "matrix_vector_multiply"],
		searchSymbol: "matrix_vector_multiply",
		searchKind: "method",
	},
	{
		lang: "JavaScript",
		relFile: "src/http.js",
		expectedNames: ["Cache", "HttpService", "get", "set", "delete", "fetchJson"],
		searchSymbol: "fetchJson",
		searchKind: "method",
	},
	{
		lang: "Rust",
		relFile: "src/worker.rs",
		expectedNames: ["TaskWorker", "process_job", "allocate_raw", "stop", "state"],
		searchSymbol: "process_job",
		searchKind: "method",
	},
	{
		lang: "Go",
		relFile: "src/router.go",
		expectedNames: ["FileStore", "ServeRequest", "Ping", "Shutdown", "InitRouter", "NewRouter", "Router"],
		searchSymbol: "FileStore",
		searchKind: "class",
	},
	{
		lang: "Java",
		relFile: "src/PaymentService.java",
		expectedNames: ["PaymentService", "commit", "refund", "rollbackAsync", "shutdown", "getBalance"],
		searchSymbol: "commit",
		searchKind: "method",
	},
	{
		lang: "PHP",
		relFile: "src/CacheManager.php",
		expectedNames: ["CacheManager", "get", "set", "delete", "flushAll", "stats"],
		searchSymbol: "flushAll",
		searchKind: "method",
	},
	{
		lang: "Ruby",
		relFile: "src/report.rb",
		expectedNames: ["ReportEntry", "ReportGenerator", "add_entry", "generate_summary", "render"],
		searchSymbol: "generate_summary",
		searchKind: "method",
	},
	{
		lang: "Bash",
		relFile: "src/deploy.sh",
		expectedNames: ["deploy_cluster", "rollback_cluster", "health_check"],
		searchSymbol: "deploy_cluster",
		searchKind: "function",
	},
	{
		lang: "Python",
		relFile: "calculator.py", // Python fixture lives in workspace root, not src/
		expectedNames: ["Calculator", "Transaction", "calculate_tax", "process_discount", "apply_transaction", "find_largest"],
		searchSymbol: "calculate_tax",
		searchKind: "method",
	},
];

function runColdProcess(cwd: string, relFile: string, expectedNames: string[]): { total: number; found: string[]; missing: string[] } {
	const fullFilePath = path.join(cwd, relFile);
	const probeScript = path.join(__dirname, "..", "tests", "cold_process_probe.ts");
	// Build a temp script that imports the probe, runs it, then exits.
	const tmpScript = path.join(os.tmpdir(), `cold_probe_runner_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`);
	const scriptContent = `import { spawnSync } from "node:child_process";
const probeScript = ${JSON.stringify(probeScript)};
const filePath = ${JSON.stringify(fullFilePath)};
const expectedNames = ${JSON.stringify(expectedNames)};
const result = spawnSync(process.execPath, [${JSON.stringify(path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"))}, probeScript, filePath, ...expectedNames], { encoding: "utf8", cwd: ${JSON.stringify(process.cwd())} });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`;
	fs.writeFileSync(tmpScript, scriptContent, "utf8");

	try {
		// Use a fresh tsx process for each language to ensure TreeSitter state is uninitialized
		const tsxPath = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
		const result = spawnSync(process.execPath, [tsxPath, tmpScript], {
			encoding: "utf8",
			cwd: process.cwd(),
			timeout: 60_000,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`Subprocess failed (status ${result.status}): ${result.stderr}`);
		}
		const lines = (result.stdout || "").trim().split("\n");
		const last = lines[lines.length - 1];
		return JSON.parse(last);
	} finally {
		try { fs.unlinkSync(tmpScript); } catch {}
	}
}

async function main() {
	console.log("=== COLD-PROCESS REPRODUCTION OF REGEX FALLBACK BUGS ===");
	console.log("(Each test spawns a fresh tsx subprocess with no warm TreeSitter cache.)\n");

	const ws = createPolyglotWorkspace("cold_repro_");
	try {
		let totalFailures = 0;

		for (const tc of TEST_CASES) {
			let res: { total: number; found: string[]; missing: string[] };
			try {
				res = runColdProcess(ws.tempDir, tc.relFile, tc.expectedNames);
			} catch (e: any) {
				console.log(`  ✗ [${tc.lang}] cold-process invocation failed: ${e.message}`);
				totalFailures++;
				continue;
			}

			if (res.missing.length === 0) {
				console.log(`  ✓ [${tc.lang}] all ${tc.expectedNames.length} symbols extracted (no bug)`);
			} else {
				console.log(`  ✗ [${tc.lang}] ${res.missing.length}/${tc.expectedNames.length} symbols missing:`);
				console.log(`      missing: ${res.missing.join(", ")}`);
				totalFailures++;
			}
		}

		console.log(`\n=== COLD-PROCESS REPRODUCTION RESULTS: ${totalFailures} languages affected ===`);
	} finally {
		ws.cleanup();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
