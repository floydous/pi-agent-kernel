// Section 20: Aliased Re-exports, Multi-line Signatures, Dotted Lookups, Import Line Hover

import * as fs from "node:fs";
import * as path from "node:path";
import { extractLocalSymbolHover, searchAstSymbols } from "../retrieval/ast_search";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("20. Aliased Re-exports, Multi-line Signatures, Dotted Lookups, Import Hover", () => {
		const ws = createTestWorkspace();
		try {
			const srcDir = path.join(ws.tempDir, "src", "webshocket");
			const testsDir = path.join(ws.tempDir, "tests");
			fs.mkdirSync(srcDir, { recursive: true });
			fs.mkdirSync(testsDir, { recursive: true });

			fs.writeFileSync(
				path.join(srcDir, "websocket.py"),
				`class client(
    BaseClient,
    Generic[T],
):
    """Core underlying WebSocket client."""
    def __init__(
        self,
        url: str,
        timeout: float = 30.0,
    ):
        self.url = url
`,
				"utf8"
			);

			fs.writeFileSync(
				path.join(srcDir, "__init__.py"),
				`from .websocket import (
    client as WebSocketClient,
)
from .rpc import rate_limit, rpc_method

__all__ = ["WebSocketClient", "rate_limit", "rpc_method"]
`,
				"utf8"
			);

			fs.writeFileSync(
				path.join(srcDir, "rpc.py"),
				`def rate_limit(
    calls: int = 100,
    period: float = 60.0,
) -> Callable:
    """Production rate limiter decorator."""
    pass

def rpc_method(
    name: str = "",
) -> Callable:
    pass
`,
				"utf8"
			);

			fs.writeFileSync(
				path.join(testsDir, "test_rpc.py"),
				`def test_rate_limit():
    pass

def test_rate_limit_streaming():
    pass

def test_rate_limit_burst():
    pass

def raise_rate_limit_exceeded():
    pass
`,
				"utf8"
			);

			// Query alias WebSocketClient
			const aliasHits = searchAstSymbols(ws.tempDir, { name: "WebSocketClient" });
			assertPass(
				"Aliased re-export resolution for WebSocketClient",
				aliasHits.length > 0 && aliasHits.some((h) => h.filePath.includes("websocket.py") && h.aliasedFrom?.originalName === "client"),
				{ aliasHits }
			);
			logPass("Multi-line aliased re-export resolution verified (WebSocketClient → client)!");

			// Query dotted symbol webshocket.WebSocketClient
			const dottedHits = searchAstSymbols(ws.tempDir, { name: "webshocket.WebSocketClient" });
			assertPass(
				"Dotted symbol lookup for webshocket.WebSocketClient",
				dottedHits.length > 0 && dottedHits[0].filePath.includes("websocket.py"),
				{ dottedHits }
			);
			logPass("Dotted symbol lookup verified (webshocket.WebSocketClient resolved)!");

			// Query shadowed name rate_limit with multi-line signature
			const rateLimitHits = searchAstSymbols(ws.tempDir, { name: "rate_limit" });
			assertPass(
				"Multi-tier ranking puts production rate_limit first",
				rateLimitHits.length > 0 &&
					rateLimitHits[0].filePath.includes("rpc.py") &&
					rateLimitHits[0].name === "rate_limit",
				{ rateLimitHits }
			);
			assertPass(
				"Multi-line function signature extraction for rate_limit",
				rateLimitHits[0].signature.includes("calls: int = 100"),
				{ signature: rateLimitHits[0].signature }
			);
			logPass("Multi-line signature extraction & multi-tier result ranking verified!");

			// Test Hover on Import Line
			const initPyPath = path.join(srcDir, "__init__.py");
			const importHover = extractLocalSymbolHover(initPyPath, 3, 20, "rate_limit");
			assertPass(
				"Import line hover for rate_limit",
				!!importHover && importHover.includes("(imported symbol) rate_limit") && !importHover.includes("(parameter)"),
				{ importHover }
			);
			const keywordHover = extractLocalSymbolHover(initPyPath, 3, 10, "import");
			assertPass(
				"Keyword hover returns null for 'import'",
				keywordHover === null,
				{ keywordHover }
			);
			logPass("Import line hover & keyword defense verified!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
