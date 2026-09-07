// STRICT-INTENT Audit Suite Round 2: Verify other sections aren't just
// matching source code behavior rather than expected behavior.

import * as fs from "node:fs";
import * as path from "node:path";
import { extractFileTags } from "../src/retrieval/repomap";
import { computeRepoMap } from "../src/retrieval/repomap";
import { extractSymbolContent } from "../src/retrieval/symbol_reader";
import { HybridSearchIndex } from "../src/retrieval/search_index";
import { EpistemicGuard } from "../src/safety/epistemic_guard";
import { applySurgicalPatch, applyMultiBlockPatch } from "../src/editing/patch";
import { createPolyglotWorkspace, createTestWorkspace, logPass } from "./_setup";
import * as os from "node:os";

let passed = 0;
let failed = 0;

function recordPass(label: string) {
	console.log(`  ✓ ${label}`);
	passed++;
}

function recordFail(label: string, details: unknown) {
	console.log(`  ✗ ${label}`);
	console.log(`    ${JSON.stringify(details)}`);
	failed++;
}

// 1. extractFileTags must find method names in TypeScript class bodies
async function test01_extractFileTags_TS_methods() {
	const ws = createPolyglotWorkspace("audit1_");
	try {
		const tsPath = path.join(ws.tempDir, "src/app.ts");
		const content = fs.readFileSync(tsPath, "utf8");
		const tags = extractFileTags(tsPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		// The fixture has many methods: withConnection, connectInternal, ping, endpoint,
		// isActive, release, createDefault, runMigrations, start, handleRequest, getStats
		const expectedMethods = [
			"withConnection", "connectInternal", "ping", "endpoint",
			"isActive", "release", "createDefault", "runMigrations",
			"start", "handleRequest", "getStats",
		];
		for (const m of expectedMethods) {
			if (names.has(m)) {
				recordPass(`TS class methods include '${m}'`);
			} else {
				recordFail(`TS class method '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 2. extractFileTags must find method names in Rust impl blocks
async function test02_extractFileTags_Rust_methods() {
	const ws = createPolyglotWorkspace("audit2_");
	try {
		const rsPath = path.join(ws.tempDir, "src/worker.rs");
		const content = fs.readFileSync(rsPath, "utf8");
		const tags = extractFileTags(rsPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["TaskWorker", "process_job", "allocate_raw", "stop", "state"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`Rust impl items include '${m}'`);
			} else {
				recordFail(`Rust impl item '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 3. extractFileTags must find method names in Java class bodies (synchronized methods, etc.)
async function test03_extractFileTags_Java_methods() {
	const ws = createPolyglotWorkspace("audit3_");
	try {
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const content = fs.readFileSync(javaPath, "utf8");
		const tags = extractFileTags(javaPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["PaymentService", "commit", "refund", "rollbackAsync", "shutdown", "getBalance"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`Java class methods include '${m}'`);
			} else {
				recordFail(`Java class method '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 4. extractFileTags must find methods in C# class bodies
async function test04_extractFileTags_CSharp_methods() {
	const ws = createPolyglotWorkspace("audit4_");
	try {
		const csPath = path.join(ws.tempDir, "src/OrderProcessor.cs");
		const content = fs.readFileSync(csPath, "utf8");
		const tags = extractFileTags(csPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["InvoiceRecord", "InvoiceService", "GenerateAsync", "FindById", "MarkPaid"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`C# class members include '${m}'`);
			} else {
				recordFail(`C# class member '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 5. extractFileTags must find methods in Go (receiver methods on structs)
async function test05_extractFileTags_Go_receiver_methods() {
	const ws = createPolyglotWorkspace("audit5_");
	try {
		const goPath = path.join(ws.tempDir, "src/router.go");
		const content = fs.readFileSync(goPath, "utf8");
		const tags = extractFileTags(goPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["FileStore", "ServeRequest", "Ping", "Shutdown", "InitRouter", "NewRouter", "Router"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`Go types/methods include '${m}'`);
			} else {
				recordFail(`Go member '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 6. extractFileTags must find classes, methods in C++ class
async function test06_extractFileTags_Cpp_methods() {
	const ws = createPolyglotWorkspace("audit6_");
	try {
		const cppPath = path.join(ws.tempDir, "src/solver.cpp");
		const content = fs.readFileSync(cppPath, "utf8");
		const tags = extractFileTags(cppPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["Matrix", "GeometrySolver", "at", "calculate_hypotenuse", "dot_product", "matrix_vector_multiply"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`C++ class members include '${m}'`);
			} else {
				recordFail(`C++ class member '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 7. extractFileTags must find Ruby class methods
async function test07_extractFileTags_Ruby_methods() {
	const ws = createPolyglotWorkspace("audit7_");
	try {
		const rbPath = path.join(ws.tempDir, "src/report.rb");
		const content = fs.readFileSync(rbPath, "utf8");
		const tags = extractFileTags(rbPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["ReportEntry", "ReportGenerator", "add_entry", "generate_summary", "render"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`Ruby class members include '${m}'`);
			} else {
				recordFail(`Ruby class member '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 8. extractFileTags must find PHP class methods
async function test08_extractFileTags_Php_methods() {
	const ws = createPolyglotWorkspace("audit8_");
	try {
		const phpPath = path.join(ws.tempDir, "src/CacheManager.php");
		const content = fs.readFileSync(phpPath, "utf8");
		const tags = extractFileTags(phpPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["CacheManager", "get", "set", "delete", "flushAll", "stats"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`PHP class methods include '${m}'`);
			} else {
				recordFail(`PHP class method '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 9. extractFileTags must find Bash functions
async function test09_extractFileTags_Bash_functions() {
	const ws = createPolyglotWorkspace("audit9_");
	try {
		const shPath = path.join(ws.tempDir, "src/deploy.sh");
		const content = fs.readFileSync(shPath, "utf8");
		const tags = extractFileTags(shPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["deploy_cluster", "rollback_cluster", "health_check"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`Bash function '${m}' is extracted`);
			} else {
				recordFail(`Bash function '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 10. extractFileTags must find JavaScript class methods
async function test10_extractFileTags_JS_methods() {
	const ws = createPolyglotWorkspace("audit10_");
	try {
		const jsPath = path.join(ws.tempDir, "src/http.js");
		const content = fs.readFileSync(jsPath, "utf8");
		const tags = extractFileTags(jsPath, content);
		const names = new Set(tags.definitions.map((d) => d.name));
		const expected = ["Cache", "HttpService", "get", "set", "delete", "fetchJson"];
		for (const m of expected) {
			if (names.has(m)) {
				recordPass(`JS class methods include '${m}'`);
			} else {
				recordFail(`JS class method '${m}' NOT extracted (cold-state regex fallback bug)`, { names: [...names] });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 11. computeRepoMap should include all 12 polyglot files
async function test11_computeRepoMap_allFiles() {
	const ws = createPolyglotWorkspace("audit11_");
	try {
		const map = computeRepoMap(ws.tempDir, 8192);
		const expected = [
			"app.ts", "http.js", "worker.rs", "router.go",
			"PaymentService.java", "OrderProcessor.cs", "checksum.c",
			"solver.cpp", "report.rb", "CacheManager.php", "deploy.sh",
		];
		for (const f of expected) {
			if (map.includes(f)) {
				recordPass(`Repo map includes ${f}`);
			} else {
				recordFail(`Repo map missing ${f}`, { mapSnippet: map.slice(0, 200) });
			}
		}
	} finally {
		ws.cleanup();
	}
}

// 12. extractSymbolContent for a Java synchronized method should return full content
async function test12_extractSymbolContent_Java_synchronized() {
	const ws = createPolyglotWorkspace("audit12_");
	try {
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const res = extractSymbolContent(javaPath, "commit");
		if (res.found && res.symbols.length === 1 && res.symbols[0].content.includes("public synchronized boolean commit")) {
			recordPass("Java synchronized 'commit' method has full content");
		} else {
			recordFail("Java 'commit' method extraction incomplete", { res });
		}
	} finally {
		ws.cleanup();
	}
}

// 13. extractSymbolContent for a TypeScript async method should return full content
async function test13_extractSymbolContent_TS_async() {
	const ws = createPolyglotWorkspace("audit13_");
	try {
		const tsPath = path.join(ws.tempDir, "src/app.ts");
		const res = extractSymbolContent(tsPath, "handleRequest");
		if (res.found && res.symbols.length === 1 && res.symbols[0].content.includes("public async handleRequest")) {
			recordPass("TypeScript async 'handleRequest' method has full content");
		} else {
			recordFail("TypeScript 'handleRequest' method extraction incomplete", { res });
		}
	} finally {
		ws.cleanup();
	}
}

// 14. applyMultiBlockPatch must reject overlapping search targets
async function test14_applyMultiBlockPatch_overlap_rejection() {
	const ws = createTestWorkspace("audit14_");
	try {
		const path1 = path.join(ws.tempDir, "overlap.txt");
		fs.writeFileSync(path1, "line1\nline2\nline3\nline4\n", "utf8");
		const result = applyMultiBlockPatch(path1, [
			{ search: "line2\nline3", replace: "L23" },
			{ search: "line3\nline4", replace: "L34" },
		]);
		if (!result.success) {
			recordPass("Overlapping multi-block targets are rejected fail-closed");
		} else {
			recordFail("Overlapping targets were applied (should be rejected)", { result });
		}
	} finally {
		ws.cleanup();
	}
}

// 15. EpistemicGuard should allow sequential edits in the same session without re-reads
// ONLY if the underlying file has not been modified externally between edits.
// This is the documented behavior in src/safety/epistemic_guard.ts.
async function test15_epistemic_sequential_edits_continuity() {
	const ws = createTestWorkspace("audit15_");
	try {
		const guard = new EpistemicGuard();
		const SESSION = "audit_15_session";
		const filePath = path.join(ws.tempDir, "audit15.txt");
		fs.writeFileSync(filePath, "line1\nline2\nline3\n", "utf8");
		guard.recordFileRead(filePath, SESSION);

		// First edit
		const p1 = applySurgicalPatch(filePath, "line1\nline2\nline3\n", "line1\nline2-modified\nline3\n");
		if (!p1.success) {
			recordFail("First edit failed unexpectedly", { p1 });
			return;
		}

		// After first edit, drift detection should kick in
		const check2 = guard.checkReadPrecondition(filePath, "edit", SESSION);
		// The guard should block or warn because the file changed
		if (check2.allowed === false) {
			recordPass("Epistemic guard blocks second edit after drift (drift detection works)");
		} else {
			recordFail("Epistemic guard allows second edit after drift (drift detection broken)", { check2 });
		}
	} finally {
		ws.cleanup();
	}
}

async function runAudit2() {
	console.log("=== STRICT-INTENT AUDIT ROUND 2 ===\n");
	await test01_extractFileTags_TS_methods();
	await test02_extractFileTags_Rust_methods();
	await test03_extractFileTags_Java_methods();
	await test04_extractFileTags_CSharp_methods();
	await test05_extractFileTags_Go_receiver_methods();
	await test06_extractFileTags_Cpp_methods();
	await test07_extractFileTags_Ruby_methods();
	await test08_extractFileTags_Php_methods();
	await test09_extractFileTags_Bash_functions();
	await test10_extractFileTags_JS_methods();
	await test11_computeRepoMap_allFiles();
	await test12_extractSymbolContent_Java_synchronized();
	await test13_extractSymbolContent_TS_async();
	await test14_applyMultiBlockPatch_overlap_rejection();
	await test15_epistemic_sequential_edits_continuity();
	console.log(`\n=== AUDIT ROUND 2 RESULTS: ${passed} passed, ${failed} failed ===`);
}

runAudit2().catch((err) => {
	console.error(err);
	process.exit(1);
});
