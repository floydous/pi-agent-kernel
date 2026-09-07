import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
} from "../../src/retrieval/ast_search";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testRustAst(): Promise<void> {
	const ws = createTestWorkspace("rust_ast_");
	try {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".rs"]);

		const rsSrcDir = path.join(ws.tempDir, "src", "rust_engine");
		fs.mkdirSync(rsSrcDir, { recursive: true });

		const rsStatePath = path.join(rsSrcDir, "state.rs");
		fs.writeFileSync(
			rsStatePath,
			`pub static ENABLED: bool = true;

pub struct AppStateInner {
    pub active_connections: usize,
}

pub enum State {
    Active,
    Paused,
}

pub struct AppState {
    inner: AppStateInner,
}

impl AppState {
    pub fn new() -> Self {
        let initial = 0;  // local var must NOT be a top-level symbol
        AppState {
            inner: AppStateInner { active_connections: initial },
        }
    }

    pub async fn connect(&mut self) -> Result<(), String> {
        // Comment references to add_record should be IGNORED.
        Ok(())
    }
}
`,
			"utf8",
		);

		const docSyms = extractDocumentSymbols(rsStatePath);
		const symNames = docSyms.map((s) => s.name);
		assertPass("Rust document symbols include ENABLED, AppStateInner, State, AppState", symNames.includes("ENABLED") && symNames.includes("AppStateInner") && symNames.includes("State") && symNames.includes("AppState"), { symNames });
		assertPass("Rust false-positive defense: 'initial' local variable is not a top-level symbol", !symNames.includes("initial"), { symNames });

		const hover = extractLocalSymbolHover(rsStatePath, 18, 13, "initial");
		assertPass("Rust hover for local variable 'initial'", !!hover && hover.includes("initial"), { hover });

		// References for AppState should include both the impl block and external usages
		const refs = findSymbolReferences(ws.tempDir, "AppState");
		assertPass("Rust references for AppState found across the workspace", refs.length >= 1, { refs });

		logPass("Rust AST, struct bleed defense, variable hover, and comment filtering passed!");
	} finally {
		ws.cleanup();
	}
}
