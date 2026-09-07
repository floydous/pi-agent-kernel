// STRICT-INTENT Audit Suite: These tests document the EXPECTED behavior.
// They are designed to FAIL if the source code has bugs, so that we can
// see what still needs fixing. We log passes/failures without throwing.

import * as fs from "node:fs";
import * as path from "node:path";
import { checkSyntax } from "../src/editing/syntax-verify";
import { extractLocalSymbolHover, searchAstSymbols } from "../src/retrieval/ast_search";
import { extractSymbolContent } from "../src/retrieval/symbol_reader";
import { createPolyglotWorkspace, logPass } from "./_setup";

function recordPass(label: string) {
	console.log(`  ✓ ${label}`);
}

function recordFail(label: string, details: unknown) {
	console.log(`  ✗ ${label}`);
	console.log(`    ${JSON.stringify(details)}`);
}

/**
 * Test 1: Java syntax validator must catch malformed Java.
 * Expected: checkSyntax should return valid=false for a broken Java file.
 * Current code: returns valid=true (no-op for .java).
 */
export async function testJavaSyntaxValidator(): Promise<void> {
	const ws = createPolyglotWorkspace("strict_audit_java_");
	try {
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const original = fs.readFileSync(javaPath, "utf8");
		// Inject a real syntactic error: missing closing brace at end of commit()
		const broken = original.replace(
			"public synchronized boolean commit(long txId) {",
			"public synchronized boolean commit(long txId) {"
		).replace(
			"if (shutdown) {",
			"if (shutdown) {" // (no real change here; we mutate below)
		);
		// Remove a closing brace
		const withoutBrace = broken.replace("    }\n    public synchronized Optional<Double>", "    public synchronized Optional<Double>");
		fs.writeFileSync(javaPath, withoutBrace, "utf8");
		const result = checkSyntax(javaPath);
		if (result.valid === false) {
			recordPass("Java syntax validator catches malformed Java");
		} else {
			recordFail("Java syntax validator is a NO-OP for .java files (bug in src/editing/syntax-verify.ts)", { result });
		}
		fs.writeFileSync(javaPath, original, "utf8");
	} finally {
		ws.cleanup();
	}
}

/**
 * Test 2: extractSymbolContent should find the main() function in main.py.
 */
export async function testPythonMainExtraction(): Promise<void> {
	const ws = createPolyglotWorkspace("strict_audit_py_");
	try {
		const mainPath = path.join(ws.tempDir, "main.py");
		const res = extractSymbolContent(mainPath, "main");
		if (res.found && res.symbols.length === 1) {
			recordPass("Python main() function is extracted");
		} else {
			recordFail("Python main() extraction failed", { res });
		}
	} finally {
		ws.cleanup();
	}
}

/**
 * Test 3: ast_search should find the Java 'commit' method in cold state.
 * Tests if the cold-state regex path correctly identifies class methods.
 */
export async function testJavaClassMethodExtraction(): Promise<void> {
	const ws = createPolyglotWorkspace("strict_audit_java_method_");
	try {
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const res = extractSymbolContent(javaPath, "commit");
		if (res.found && res.symbols.length === 1) {
			recordPass("Java 'commit' method is extractable (cold state)");
		} else {
			recordFail("Java 'commit' method NOT found in cold state (cold-state fallback in src/retrieval/repomap.ts does not walk class bodies)", { res });
		}
	} finally {
		ws.cleanup();
	}
}

/**
 * Test 4: Hover on a parameter in a Python function should work.
 */
export async function testPythonParameterHover(): Promise<void> {
	const ws = createPolyglotWorkspace("strict_audit_hover_");
	try {
		// The Python fixture lives in the workspace, not in src/
		const pyPath = path.join(ws.tempDir, "calculator.py");
		const content = fs.readFileSync(pyPath, "utf8");
		const lines = content.split("\n");
		let targetLine = -1;
		let targetCol = -1;
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(/def calculate_tax\(self, subtotal/);
			if (match) {
				targetLine = i;
				const beforeSubtotal = lines[i].indexOf("subtotal");
				targetCol = beforeSubtotal + 4;
				break;
			}
		}
		if (targetLine < 0) {
			recordFail("Could not find calculate_tax in fixture", { pyPath });
			return;
		}
		const hover = extractLocalSymbolHover(pyPath, targetLine + 1, targetCol, "subtotal");
		if (!!hover && hover.includes("subtotal")) {
			recordPass("Python parameter hover on 'subtotal' returns meaningful string");
		} else {
			recordFail("Python parameter hover on 'subtotal' is empty or incorrect", { hover });
		}
	} finally {
		ws.cleanup();
	}
}

/**
 * Test 5: searchAstSymbols finds the "DatabaseOptions" interface in app.ts.
 * Tests if hierarchical grouped AST search handles interfaces.
 */
export async function testTypescriptInterfaceSearch(): Promise<void> {
	const ws = createPolyglotWorkspace("strict_audit_ts_interface_");
	try {
		const all = searchAstSymbols(ws.tempDir, { name: "DatabaseOptions" });
		if (all.length > 0 && all[0].name === "DatabaseOptions") {
			recordPass("searchAstSymbols finds the DatabaseOptions TypeScript interface");
		} else {
			recordFail("searchAstSymbols cannot find the DatabaseOptions interface", { all });
		}
	} finally {
		ws.cleanup();
	}
}

/**
 * Test 6: searchAstSymbols should find the "commit" method in PaymentService.java
 * even with the new realistic fixture containing the synchronized method.
 */
export async function testJavaSynchronizedMethod(): Promise<void> {
	const ws = createPolyglotWorkspace("strict_audit_java_sync_");
	try {
		const all = searchAstSymbols(ws.tempDir, { name: "commit" });
		// Find any match in PaymentService.java
		const javaMatch = all.find((r) => r.filePath.includes("PaymentService.java") && r.name === "commit");
		if (javaMatch) {
			recordPass("searchAstSymbols finds synchronized 'commit' method in Java");
		} else {
			recordFail("searchAstSymbols does not find Java synchronized 'commit' method (cold-state regex fallback)", { all });
		}
	} finally {
		ws.cleanup();
	}
}

export async function runStrictAudit(): Promise<void> {
	console.log("=== STRICT-INTENT AUDIT SUITE ===");
	console.log("(Each test verifies the EXPECTED behavior. Failures expose real source-code bugs.)\n");

	await testJavaSyntaxValidator();
	await testPythonMainExtraction();
	await testJavaClassMethodExtraction();
	await testPythonParameterHover();
	await testTypescriptInterfaceSearch();
	await testJavaSynchronizedMethod();

	console.log("\n=== END OF STRICT-INTENT AUDIT ===");
	logPass("Strict-intent audit completed. ✗ marks indicate real source-code bugs that should be fixed.");
}

runStrictAudit().catch((err) => {
	console.error(err);
	process.exit(1);
});
