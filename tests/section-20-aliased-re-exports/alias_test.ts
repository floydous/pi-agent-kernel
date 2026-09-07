import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractLocalSymbolHover,
	searchAstSymbols,
} from "../../src/retrieval/ast_search";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testAliasedReExports(): Promise<void> {
	const ws = createTestWorkspace("alias_py_");
	try {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".py"]);

		const srcDir = path.join(ws.tempDir, "src", "webshocket");
		const testsDir = path.join(ws.tempDir, "tests");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(testsDir, { recursive: true });

		fs.writeFileSync(
			path.join(srcDir, "websocket.py"),
			`class client(\n    BaseClient,\n    Generic[T],\n):\n    def connect(self):\n        return "connected"\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(srcDir, "__init__.py"),
			`from .websocket import client as WebSocketClient\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(testsDir, "test_alias.py"),
			`from webshocket import WebSocketClient\nws = WebSocketClient()\nws.connect()\n`,
			"utf8",
		);

		// Query for the alias name WebSocketClient
		const aliasHits = searchAstSymbols(ws.tempDir, { name: "WebSocketClient" });
		assertPass("WebSocketClient alias is discovered", aliasHits.length > 0, { aliasHits });

		// The original 'client' name should also be discoverable
		const origHits = searchAstSymbols(ws.tempDir, { name: "client" });
		assertPass("Original 'client' name is also discoverable", origHits.length > 0, { origHits });

		logPass("Aliased re-exports and dotted lookups verified!");
	} finally {
		ws.cleanup();
	}
}
