// Cold-process contract test: every case runs in a fresh subprocess so no
// grammar is preloaded before the fallback path is exercised.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { assertPass, createPolyglotWorkspace, runSuite } from "../_setup";

interface TestCase {
	lang: string;
	relFile: string;
	expectedNames: string[];
	expectedKinds: Record<string, string>;
	forbiddenNames?: string[];
}

const TEST_CASES: TestCase[] = [
	{ lang: "TypeScript", relFile: "src/app.ts", expectedNames: ["withConnection", "connectInternal", "ping", "endpoint", "isActive", "release", "createDefault", "runMigrations", "start", "handleRequest", "getStats"], expectedKinds: { withConnection: "method", connectInternal: "method", ping: "method", endpoint: "method", isActive: "method", release: "method", createDefault: "method", runMigrations: "method", start: "method", handleRequest: "method", getStats: "method" }, forbiddenNames: ["conn"] },
	{ lang: "C#", relFile: "src/OrderProcessor.cs", expectedNames: ["InvoiceRecord", "InvoiceService", "GenerateAsync", "FindById", "MarkPaid"], expectedKinds: { InvoiceRecord: "class", InvoiceService: "class", GenerateAsync: "method", FindById: "method", MarkPaid: "method" } },
	{ lang: "C++", relFile: "src/solver.cpp", expectedNames: ["Matrix", "GeometrySolver", "at", "calculate_hypotenuse", "dot_product", "matrix_vector_multiply"], expectedKinds: { Matrix: "class", GeometrySolver: "class", at: "method", calculate_hypotenuse: "method", dot_product: "method", matrix_vector_multiply: "method" } },
	{ lang: "JavaScript", relFile: "src/http.js", expectedNames: ["Cache", "HttpService", "get", "set", "delete", "fetchJson"], expectedKinds: { Cache: "class", HttpService: "class", get: "method", set: "method", delete: "method", fetchJson: "method" }, forbiddenNames: ["url", "cached", "response", "data"] },
	{ lang: "Rust", relFile: "src/worker.rs", expectedNames: ["TaskWorker", "process_job", "allocate_raw", "stop", "state"], expectedKinds: { TaskWorker: "struct", process_job: "method", allocate_raw: "method", stop: "method", state: "method" } },
	{ lang: "Go", relFile: "src/router.go", expectedNames: ["FileStore", "ServeRequest", "Ping", "Shutdown", "InitRouter", "NewRouter", "Router"], expectedKinds: { FileStore: "class", ServeRequest: "method", Ping: "method", Shutdown: "method", InitRouter: "function", NewRouter: "function", Router: "class" } },
	{ lang: "Java", relFile: "src/PaymentService.java", expectedNames: ["PaymentService", "commit", "refund", "rollbackAsync", "shutdown", "getBalance"], expectedKinds: { PaymentService: "class", commit: "method", refund: "method", rollbackAsync: "method", shutdown: "method", getBalance: "method" } },
	{ lang: "PHP", relFile: "src/CacheManager.php", expectedNames: ["CacheManager", "get", "set", "delete", "flushAll", "stats"], expectedKinds: { CacheManager: "class", get: "method", set: "method", delete: "method", flushAll: "method", stats: "method" } },
	{ lang: "Ruby", relFile: "src/report.rb", expectedNames: ["ReportEntry", "ReportGenerator", "add_entry", "generate_summary", "render"], expectedKinds: { ReportEntry: "class", ReportGenerator: "class", add_entry: "method", generate_summary: "method", render: "method" } },
	{ lang: "Bash", relFile: "src/deploy.sh", expectedNames: ["deploy_cluster", "rollback_cluster", "health_check"], expectedKinds: { deploy_cluster: "function", rollback_cluster: "function", health_check: "function" } },
	{ lang: "Python", relFile: "calculator.py", expectedNames: ["Calculator", "Transaction", "calculate_tax", "process_discount", "apply_transaction", "find_largest"], expectedKinds: { Calculator: "class", Transaction: "class", calculate_tax: "method", process_discount: "method", apply_transaction: "method", find_largest: "method" } }
];

interface ProbeResult {
	definitions: Array<{ name: string; kind: string; line: number }>;
}

function runColdProcess(cwd: string, relFile: string, expectedNames: string[]): ProbeResult {
	const fullFilePath = path.join(cwd, relFile);
	const probeScript = path.join(__dirname, "cold-process-probe.ts");
	const tmpScript = path.join(os.tmpdir(), `cold_probe_runner_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`);
	const tsxPath = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
	const scriptContent = `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [${JSON.stringify(tsxPath)}, ${JSON.stringify(probeScript)}, ${JSON.stringify(fullFilePath)}, ...${JSON.stringify(expectedNames)}], { encoding: "utf8", cwd: ${JSON.stringify(process.cwd())} });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`;
	fs.writeFileSync(tmpScript, scriptContent, "utf8");

	try {
		const result = spawnSync(process.execPath, [tsxPath, tmpScript], {
			encoding: "utf8",
			cwd: process.cwd(),
			timeout: 60_000,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`Subprocess failed (status ${result.status}): ${result.stderr}`);
		const lines = (result.stdout || "").trim().split("\n");
		return JSON.parse(lines[lines.length - 1]) as ProbeResult;
	} finally {
		try { fs.unlinkSync(tmpScript); } catch {}
	}
}

export async function run(): Promise<void> {
	await runSuite("Cold-Process AST Extraction", async () => {
		const ws = createPolyglotWorkspace("cold_repro_");
		try {
			let failures = 0;
			for (const testCase of TEST_CASES) {
				let result: ProbeResult;
				try {
					result = runColdProcess(ws.tempDir, testCase.relFile, testCase.expectedNames);
				} catch (error) {
					console.log(`  ✗ [${testCase.lang}] subprocess failed: ${error}`);
					failures++;
					continue;
				}

				const expected = [...new Set(testCase.expectedNames)].sort();
				const actual = [...new Set(result.definitions.map((definition) => definition.name))].sort();
				const missing = expected.filter((name) => !actual.includes(name));
				const wrongKinds = expected.filter((name) => {
					const definition = result.definitions.find((candidate) => candidate.name === name);
					return definition && definition.kind !== testCase.expectedKinds[name];
				});
				const forbidden = (testCase.forbiddenNames ?? []).filter((name) => actual.includes(name));
				if (missing.length === 0 && wrongKinds.length === 0 && forbidden.length === 0) {
					console.log(`  ✓ [${testCase.lang}] exact required symbols extracted`);
				} else {
					console.log(`  ✗ [${testCase.lang}] cold extraction differs from fixture contract`);
					if (missing.length) console.log(`      missing: ${missing.join(", ")}`);
					if (wrongKinds.length) console.log(`      wrong kinds: ${wrongKinds.join(", ")}`);
					if (forbidden.length) console.log(`      leaked locals: ${forbidden.join(", ")}`);
					failures++;
				}
			}

			assertPass("Every cold-process fixture matches its exact symbol contract", failures === 0, { failures });
		} finally {
			ws.cleanup();
		}
	});
}

if (require.main === module) {
	run().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
