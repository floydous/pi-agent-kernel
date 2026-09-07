import * as fs from "node:fs";
import * as path from "node:path";
import { searchAstSymbols } from "../../src/retrieval/ast_search";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "alias_re_export");

export async function testAliasedReExports(): Promise<void> {
	const ws = createTestWorkspace("alias_py_");
	try {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".py"]);

		const srcDir = path.join(ws.tempDir, "src", "webshocket");
		const testsDir = path.join(ws.tempDir, "tests");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(testsDir, { recursive: true });

		// Copy committed fixture files into the test workspace
		fs.copyFileSync(path.join(FIXTURE_DIR, "websocket.py"), path.join(srcDir, "websocket.py"));
		fs.copyFileSync(path.join(FIXTURE_DIR, "__init__.py"), path.join(srcDir, "__init__.py"));
		fs.copyFileSync(path.join(FIXTURE_DIR, "test_alias.py"), path.join(testsDir, "test_alias.py"));

		const aliasHits = searchAstSymbols(ws.tempDir, { name: "WebSocketClient" });
		assertPass("WebSocketClient alias is discovered", aliasHits.length > 0, { aliasHits });

		const origHits = searchAstSymbols(ws.tempDir, { name: "client" });
		assertPass("Original 'client' name is also discoverable", origHits.length > 0, { origHits });

		logPass("Aliased re-exports and dotted lookups verified!");
	} finally {
		ws.cleanup();
	}
}
