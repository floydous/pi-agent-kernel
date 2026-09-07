import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
} from "../../src/retrieval/ast_search";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "rust");

export async function testRustAst(): Promise<void> {
	const ws = createTestWorkspace("rust_ast_");
	try {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".rs"]);

		const rsSrcDir = path.join(ws.tempDir, "src", "rust_engine");
		fs.mkdirSync(rsSrcDir, { recursive: true });

		const rsStatePath = path.join(rsSrcDir, "state.rs");
		fs.copyFileSync(path.join(FIXTURE_DIR, "state.rs"), rsStatePath);

		const docSyms = extractDocumentSymbols(rsStatePath);
		const symNames = docSyms.map((s) => s.name);
		assertPass("Rust document symbols include ENABLED, AppStateInner, State, AppState",
			symNames.includes("ENABLED") && symNames.includes("AppStateInner") && symNames.includes("State") && symNames.includes("AppState"),
			{ symNames }
		);
		assertPass("Rust false-positive defense: 'initial' local variable is not a top-level symbol", !symNames.includes("initial"), { symNames });

		const hover = extractLocalSymbolHover(rsStatePath, 18, 13, "initial");
		assertPass("Rust hover for local variable 'initial'", !!hover && hover.includes("initial"), { hover });

		const refs = findSymbolReferences(ws.tempDir, "AppState");
		assertPass("Rust references for AppState found across the workspace", refs.length >= 1, { refs });

		logPass("Rust AST, struct bleed defense, variable hover, and comment filtering passed!");
	} finally {
		ws.cleanup();
	}
}
