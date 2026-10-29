import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkSyntaxContent, resetNodeExecutableCache, setNodeExecutableForTesting } from "../../src/editing/syntax-verify";
import { applySurgicalPatch } from "../../src/editing/patch";
import { verifyEditedFile } from "../../src/editing/post_edit_verification";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { logPass } from "../_setup";

// Valid TypeScript that the bundled tree-sitter grammar rejects (variance annotations), so tsc must decide.
const GRAMMAR_GAP_TS = "export interface Box<out T> { get(): T }\n";

export async function testTreeSitterGate(): Promise<void> {
	await TreeSitterEngine.getInstance().loadLanguages([".ts", ".rs", ".js"]);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syntax_ts_gate_"));
	try {
		// TypeScript: tree-sitter clears clean content without tsc; anything it flags goes to tsc.
		setNodeExecutableForTesting(null); // tsc cannot run: a "clean" verdict proves tree-sitter decided
		const ts = path.join(dir, "a.ts");
		const valid = "export const x: number = 1;\n";
		assert.equal(checkSyntaxContent(ts, valid, valid).status, "clean", "tree-sitter clears clean TS without tsc");
		assert.equal(checkSyntaxContent(ts, valid).status, "clean", "no original: clean TS is still cleared by tree-sitter");
		assert.equal(checkSyntaxContent(ts, GRAMMAR_GAP_TS, valid).status, "unavailable", "a grammar error is left to tsc");
		assert.equal(checkSyntaxContent(ts, valid, GRAMMAR_GAP_TS).status, "unavailable", "an original tree-sitter cannot parse is left to tsc");
		resetNodeExecutableCache();
		const gap = checkSyntaxContent(ts, GRAMMAR_GAP_TS, valid);
		assert.equal(gap.valid, true, "tsc accepts what the grammar rejects");
		const broken = checkSyntaxContent(ts, "export const x: number = ;\n", valid);
		assert.equal(broken.status, "failed", "broken TS still fails");
		assert.ok(broken.error?.includes("TS1109"), "tsc's own diagnostic is reported");
		logPass("TypeScript: tree-sitter clears clean edits, tsc decides the rest");

		// Languages without a parser here: tree-sitter reports only when the original parsed without errors.
		const rs = path.join(dir, "lib.rs");
		const rsOk = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
		const rsBroken = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n";
		const rsFail = checkSyntaxContent(rs, rsBroken, rsOk);
		assert.equal(rsFail.status, "failed", "a new Rust syntax error is reported");
		assert.equal(rsFail.error, 'tree-sitter found a syntax error: [1:1] cannot parse lines 1-2, starting "pub fn add(a: i32, b: i32) -> i32 {"', "the error names the unparsed span");
		assert.equal(checkSyntaxContent(rs, rsOk, rsOk).status, "clean", "clean Rust is clean");
		assert.equal(checkSyntaxContent(rs, rsBroken).status, "not run", "no original: not judged");
		assert.equal(checkSyntaxContent(rs, rsBroken, "pub fn f( {}\n").status, "not run", "an original with errors: not judged");
		assert.equal(checkSyntaxContent(path.join(dir, "notes.txt"), "anything", "x").status, "not run", "no grammar, no parser: not run");
		logPass("Rust: tree-sitter reports errors only against a cleanly parsed original");

		// JavaScript: node --check alone passes ES-module syntax errors in a .js file without a package.json "type".
		const js = path.join(dir, "mod.js");
		const esmBroken = checkSyntaxContent(js, "import x from 'y';\nfunction f) { return x; }\n");
		assert.equal(esmBroken.status, "failed", "an ES-module syntax error in a .js file is caught");
		assert.ok(esmBroken.error?.includes("SyntaxError"), "node's diagnostic is reported");
		assert.equal(checkSyntaxContent(js, "import x from 'y';\nexport const z = x;\n").status, "clean", "valid ES module .js passes");
		assert.equal(checkSyntaxContent(js, "const a = require('a');\nif (!a) return;\nmodule.exports = a;\n").status, "clean", "valid CommonJS (top-level return) passes");
		assert.equal(checkSyntaxContent(js, "const a = 1;\nconst a = 2;\n").status, "failed", "early errors tree-sitter cannot see are caught by node");
		logPass("JavaScript: ES-module and CommonJS candidates are both checked by node");

		// Candidates are validated outside the project directory.
		assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".pi-agent-kernel-validate-")), [], "no temp folder in the project");
		logPass("Syntax candidates never land in the project directory");

		// A broken edit reports the verdict reached before writing, without checking the file again.
		fs.writeFileSync(rs, rsOk, "utf8");
		const patched = applySurgicalPatch(rs, "    a + b\n}", "    a + b", { syntaxGate: "warn" });
		assert.equal(patched.success, true, "warn mode applies the edit");
		assert.equal(patched.syntax?.status, "failed", "the patch carries its syntax verdict");
		const verification = await verifyEditedFile(path.join(dir, "missing.rs"), undefined, patched.syntax);
		assert.equal(verification.syntax.state, "failed", "verifyEditedFile uses the precomputed verdict");
		logPass("Edit results reuse the pre-write syntax verdict");
	} finally {
		resetNodeExecutableCache();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
