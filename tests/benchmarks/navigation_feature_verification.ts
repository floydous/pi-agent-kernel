import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { registerReadTool } from "../../src/tools/read_tool";
import { registerLspTool } from "../../src/tools/lsp_tool";
import { DedupStore } from "../../src/dedup/content_store";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { searchAstSymbols } from "../../src/retrieval/ast_search";
import { logPass } from "../_setup";
import { LspManager } from "../../src/lsp";

const repo = path.resolve(__dirname, "../..");
const fixture = path.join(repo, "tests/fixtures/polyglot");

type Tool = { execute: (...args: any[]) => Promise<any> };

function register(registerer: (pi: any, deps?: any) => void, deps?: any): Tool {
	const pi: any = { registerTool(tool: any) { pi.tool = tool; } };
	registerer(pi, deps);
	return pi.tool;
}

function text(result: any): string {
	return (result?.content || [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text || "")
		.join("\n");
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function editDistance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const next = row[j];
			row[j] = Math.min(
				row[j] + 1,
				row[j - 1] + 1,
				previous + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			previous = next;
		}
	}
	return row[b.length];
}

function suggestion(query: string): string {
	const hits = searchAstSymbols(fixture, {
		name: query,
		filePattern: "src/app.ts",
		exactMatch: false,
	});
	const ranked = hits
		.map((hit) => ({ hit, distance: editDistance(query.toLowerCase(), hit.name.toLowerCase()) }))
		.sort((a, b) => a.distance - b.distance || a.hit.line - b.hit.line)
		.slice(0, 3);
	return ranked.length === 0
		? `Symbol '${query}' not found in src/app.ts.`
		: `Symbol '${query}' not found in src/app.ts.\nDid you mean:\n${ranked.map(({ hit }) => `- ${hit.name} (${hit.filePath}:${hit.line}) [${hit.kind}] ${hit.signature}`).join("\n")}`;
}

function describe(symbol: string): string {
	const hit = searchAstSymbols(fixture, { name: symbol, exactMatch: true })[0];
	return hit
		? `source: tree-sitter\n${hit.filePath}:${hit.line}-${hit.endLine}\n[${hit.kind}] ${hit.signature}`
		: `No declaration found for '${symbol}'.`;
}

function assertTextContains(label: string, value: string, expected: string): void {
	assert.ok(value.includes(expected), `${label}: expected ${JSON.stringify(value)} to contain ${JSON.stringify(expected)}`);
}

export async function run(): Promise<void> {
	const ctx = { cwd: fixture };
	const read = register(registerReadTool, {
		getSessionId: () => "navigation-read-benchmark",
		getConfig: () => ({ safety: { max_total_bytes: 20_000 } }),
	});
	const typoResult = await read.execute(
		"read-typo",
		{ path: "src/app.ts", symbol: "withConnectio" },
		undefined,
		undefined,
		ctx,
	);
	const typoBaseline = text(typoResult);
	const typoCandidate = suggestion("withConnectio");
	assert.equal(typoResult.isError, true);
	assertTextContains("exact typo remains an error", typoBaseline, "not found");
	assertTextContains("bounded suggestion", typoCandidate, "withConnection");
	assert.ok(!typoCandidate.includes("const conn"), "suggestion must not extract a fuzzy body");

	const lsp = register(registerLspTool, {
		getSessionId: () => "navigation-lsp-benchmark",
		getConfig: () => ({ safety: { enable_epistemic_guard: true } }),
	});
	const definition = await lsp.execute(
		"lsp-definition",
		{ action: "definition", path: "src/app.ts", symbol: "withConnection" },
		undefined,
		undefined,
		ctx,
	);
	const diagnostics = await lsp.execute(
		"lsp-diagnostics",
		{ action: "diagnostics", path: "src/app.ts" },
		undefined,
		undefined,
		ctx,
	);
	const directoryDiagnostics = await lsp.execute(
		"lsp-directory",
		{ action: "diagnostics", path: "src" },
		undefined,
		undefined,
		ctx,
	);
	const bareDefinition = await lsp.execute(
		"lsp-bare-definition",
		{ action: "definition", symbol: "withConnection" },
		undefined,
		undefined,
		ctx,
	);
	assertTextContains("definition result path", text(definition), "src/app.ts");
	assert.ok(/:27(?::18)?/.test(text(definition)), `definition should resolve line 27: ${text(definition)}`);
	assertTextContains("bare definition result path", text(bareDefinition), "src/app.ts");
	assertTextContains("bare definition unique match", text(bareDefinition), "unique match for 'withConnection'");
	assert.ok(
		text(diagnostics).includes("clean") || text(diagnostics).includes("LSP"),
		`conservative diagnostics should report clean or explicit status: ${text(diagnostics)}`,
	);
	assert.ok(
		directoryDiagnostics.isError || /directory|file/i.test(text(directoryDiagnostics)),
		"directory diagnostics must not pretend a directory is a clean file",
	);

	const body = await read.execute(
		"read-symbol",
		{ path: "src/app.ts", symbol: "withConnection" },
		undefined,
		undefined,
		ctx,
	);
	const references = await lsp.execute(
		"lsp-references",
		{ action: "references", path: "src/app.ts", symbol: "withConnection", exclude_declaration: true },
		undefined,
		undefined,
		ctx,
	);
	const hover = await lsp.execute(
		"lsp-hover",
		{ action: "hover", path: "src/app.ts", symbol: "withConnection" },
		undefined,
		undefined,
		ctx,
	);
	const currentCompositeBytes = bytes([text(definition), text(body), text(references), text(hover)].join("\n"));
	const boundedDescribe = describe("withConnection");
	assert.ok(bytes(boundedDescribe) < currentCompositeBytes, "bounded description should be smaller than body+references+hover workflow");

	const store = new DedupStore();
	const content = "x".repeat(500);
	const first = store.record("dedup", "a", "code_search", { query: "save state", limit: 5 }, content, false, 0);
	const changedQuery = store.record("dedup", "b", "code_search", { query: "save state file path", limit: 5 }, content, false, 0);
	const sameParams = store.record("dedup", "c", "code_search", { query: "save state", limit: 5 }, content, false, 0);
	const differentTool = store.record("dedup", "d", "read", { path: "a" }, content, false, 0);
	assert.equal(first.isDuplicate, false);
	assert.equal(changedQuery.isDuplicate, false);
	assert.equal(sameParams.isDuplicate, true);
	assert.equal(differentTool.isDuplicate, false);

	const guard = new EpistemicGuard();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "navigation-guard-"));
	const tempFile = path.join(tempDir, "file.ts");
	try {
		fs.writeFileSync(tempFile, Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n"), "utf8");
		guard.recordFileSearched(tempFile, "guard", tempDir, {
			coverage: { complete: false, ranges: [{ startLine: 20, endLine: 25 }] },
			provenance: "code_search",
		});
		assert.equal(guard.checkReadPrecondition(tempFile, "edit", "guard", tempDir, true, [{ startLine: 20, endLine: 25 }]).allowed, false);
		guard.recordFileRead(tempFile, "guard", tempDir, undefined, {
			coverage: { complete: false, ranges: [{ startLine: 20, endLine: 25 }], totalLines: 40 },
			provenance: "read",
		});
		assert.equal(guard.checkReadPrecondition(tempFile, "edit", "guard", tempDir, true, [{ startLine: 20, endLine: 25 }]).allowed, true);
		fs.appendFileSync(tempFile, "\nexternal", "utf8");
		assert.equal(guard.checkReadPrecondition(tempFile, "edit", "guard", tempDir, true, [{ startLine: 20, endLine: 25 }]).allowed, false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}

	const rgOutput = execFileSync("rg", ["-n", "-C", "1", "withConnection", fixture], { encoding: "utf8" });
	assert.ok(rgOutput.includes("withConnection"));

	const report = {
		features: {
			fuzzyReadSuggestion: {
				baseline: { calls: 1, outputBytes: bytes(typoBaseline) },
				candidate: { calls: 1, outputBytes: bytes(typoCandidate), extraBytes: bytes(typoCandidate) - bytes(typoBaseline), exactExtraction: false },
			},
			lsp: {
				definitionBytes: bytes(text(definition)),
				bareDefinitionBytes: bytes(text(bareDefinition)),
				diagnosticsBytes: bytes(text(diagnostics)),
				directoryDiagnostics: text(directoryDiagnostics),
			},
			boundedDescribe: {
				currentCalls: 4,
				currentOutputBytes: currentCompositeBytes,
				candidateCalls: 1,
				candidateOutputBytes: bytes(boundedDescribe),
			},
			dedup: {
				changedQuerySameBytesDeduped: changedQuery.isDuplicate,
				sameParamsSameBytesDeduped: sameParams.isDuplicate,
				differentToolSameBytesDeduped: differentTool.isDuplicate,
			},
			workspaceSearch: { nativeRgCalls: 1, outputBytes: bytes(rgOutput) },
			editAuthorization: { search: false, matchingRead: true, afterExternalDrift: false },
		},
	};
	console.log(JSON.stringify(report, null, 2));
	await LspManager.getInstance().stopAll();
	logPass("Navigation feature reliability and token-efficiency benchmark verified!");
}
