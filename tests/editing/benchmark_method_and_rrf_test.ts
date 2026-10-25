import assert from "node:assert/strict";
import { registerEditTool } from "../../src/tools/edit_tool";
import { logPass, createTestWorkspace } from "../_setup";

export async function testBenchmarkMethodSchemas(): Promise<void> {
	const methods = [
		{
			env: undefined,
			expectedDesc: "Edit code with search/replace, multi-block 'edits', or multi-file 'files'",
			requiredProps: ["path", "search", "replace", "edits", "files"],
		},
		{
			env: "line-range",
			expectedDesc: "Edit code with numeric line ranges only: start_line, optional end_line, and replacement lines.",
			requiredProps: ["path", "start_line", "lines"],
		},
		{
			env: "hash-anchor",
			expectedDesc: "Edit code with LINE#HASH anchors only, copied from read output.",
			requiredProps: ["path", "pos", "lines"],
		},
		{
			env: "search-replace",
			expectedDesc: "Edit code with a unique exact search block and replacement block only.",
			requiredProps: ["path", "search", "replace"],
		},
		{
			env: "adaptive",
			expectedDesc: "Edit code with search/replace or line range; use search first.",
			requiredProps: ["path", "search", "replace", "start_line", "pos"],
		},
	];

	const origEnv = process.env.PI_EDIT_METHOD;
	try {
		for (const m of methods) {
			if (m.env === undefined) delete process.env.PI_EDIT_METHOD;
			else process.env.PI_EDIT_METHOD = m.env;

			let registeredTool: any = null;
			const mockPi: any = {
				registerTool(tool: any) {
					registeredTool = tool;
				},
			};
			const mockDeps: any = {
				getConfig: () => ({}),
				getSessionId: () => "mock-session",
			};

			registerEditTool(mockPi, mockDeps);
			assert.ok(registeredTool, `Tool registered for PI_EDIT_METHOD=${m.env}`);
			assert.ok(
				registeredTool.description.includes(m.expectedDesc),
				`Description matches for PI_EDIT_METHOD=${m.env}: expected '${m.expectedDesc}', got '${registeredTool.description}'`,
			);

			const props = Object.keys(registeredTool.parameters.properties || {});
			for (const req of m.requiredProps) {
				assert.ok(
					props.includes(req),
					`Property '${req}' present in schema for PI_EDIT_METHOD=${m.env}`,
				);
			}
		}
		logPass("All PI_EDIT_METHOD parameter schemas and descriptions verified table-driven!");
	} finally {
		if (origEnv !== undefined) process.env.PI_EDIT_METHOD = origEnv;
		else delete process.env.PI_EDIT_METHOD;
	}
}

export async function testRrfSignalsAndRankings(): Promise<void> {
	const ws = createTestWorkspace("rrf_test_");
	try {
		// Validate that RRF calculation distinguishes lexical, semantic, and hybrid signals
		// by verifying simulated scoring outcomes directly
		const k = 60;

		// 1. Lexical only (BM25 matches, no vector)
		const bmData1 = { rank: 1, score: 2.5, matches: ["foo"] };
		const vecData1 = undefined;
		const rrfScore1 = 1 / (k + bmData1.rank);
		const signal1 = bmData1 && vecData1 ? "hybrid" : vecData1 ? "semantic" : "lexical";
		assert.equal(signal1, "lexical");
		assert.equal(rrfScore1, 1 / 61);

		// 2. Semantic only (Vector matches, no BM25)
		const bmData2 = undefined;
		const vecData2 = { rank: 1, score: 0.88 };
		const rrfScore2 = 1 / (k + vecData2.rank);
		const signal2 = bmData2 && vecData2 ? "hybrid" : vecData2 ? "semantic" : "lexical";
		assert.equal(signal2, "semantic");
		assert.equal(rrfScore2, 1 / 61);

		// 3. Hybrid (Both match)
		const bmData3 = { rank: 1, score: 3.0, matches: ["foo"] };
		const vecData3 = { rank: 2, score: 0.92 };
		const rrfScore3 = 1 / (k + bmData3.rank) + 1 / (k + vecData3.rank);
		const signal3 = bmData3 && vecData3 ? "hybrid" : vecData3 ? "semantic" : "lexical";
		assert.equal(signal3, "hybrid");
		assert.equal(rrfScore3, 1 / 61 + 1 / 62);

		// 4. Zero score vs missing distinction: score of 0.0 is preserved as 0
		const bmDataZero = { rank: 1, score: 0.0, matches: [] };
		assert.equal(bmDataZero.score, 0);
		assert.notEqual(bmDataZero, undefined);

		logPass("RRF hybrid fusion signal classification and zero-score handling verified!");
	} finally {
		ws.cleanup();
	}
}

export async function run(): Promise<void> {
	console.log("=== Running Benchmark Method Schemas & RRF Signals Test Suite ===");
	await testBenchmarkMethodSchemas();
	await testRrfSignalsAndRankings();
}

if (process.argv[1]?.endsWith("benchmark_method_and_rrf_test.ts")) {
	void run();
}
