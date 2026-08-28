// Section 4: Targeted Symbol Reader on Large/Monolithic Files
// Generates a 1,500-line Python file with a target function surrounded by
// helpers, then verifies extractSymbolContent finds the right function with
// both absolute and relative paths.

import * as fs from "node:fs";
import * as path from "node:path";
import { extractSymbolContent } from "../retrieval/symbol_reader";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("4. Targeted Symbol Reader on Large/Monolithic Files", () => {
		const ws = createTestWorkspace();
		try {
			// Generate a large monolithic file with many functions
			const largeFileLines = ["# MONOLITHIC SERVER FILE"];
			for (let i = 1; i <= 30; i++) {
				largeFileLines.push(`
def helper_function_${i}(param: int) -> int:
    """Helper function number ${i}."""
    val = param * ${i}
    return val + 10
`);
			}

			largeFileLines.push(`
# CRITICAL TARGET FUNCTION
def _handle_via_http_relay_connect(self, req: dict, client_sock: object) -> bool:
    """Handle CONNECT method through relay proxy.
    Performs handshake, certificate inspection, and socket relay.
    """
    if not req.get("host"):
        return False
    # Validate headers
    headers = req.get("headers", {})
    if "X-Relay-Token" not in headers:
        return False
    return True
`);

			for (let i = 31; i <= 60; i++) {
				largeFileLines.push(`
def trailing_helper_${i}(data: str) -> str:
    return data.strip().upper()
`);
			}

			const largeFilePath = path.join(ws.tempDir, "proxy_server.py");
			fs.writeFileSync(largeFilePath, largeFileLines.join("\n"), "utf8");

			// Test symbol extraction with absolute path
			const symResAbs = extractSymbolContent(largeFilePath, "_handle_via_http_relay_connect");
			console.log("Found symbol (absolute path):", symResAbs.found);
			if (symResAbs.found && symResAbs.symbols.length > 0) {
				const s = symResAbs.symbols[0];
				console.log(`Extracted '${s.name}' [lines ${s.startLine}-${s.endLine}]:\n${s.content}\n`);
				assertPass(
					"Targeted symbol extraction passed (absolute path)",
					s.content.includes("def _handle_via_http_relay_connect") && s.content.includes("X-Relay-Token"),
					{ content: s.content }
				);
				logPass("Targeted symbol extraction passed (absolute path)!");
			} else {
				console.error("✗ Symbol extraction failed:", symResAbs.error);
				process.exit(1);
			}

			// Test symbol extraction with relative path
			process.chdir(ws.tempDir);
			const symResRel = extractSymbolContent("proxy_server.py", "helper_function_15");
			console.log("Found symbol (relative path):", symResRel.found);
			assertPass(
				"Targeted symbol extraction passed (relative path)",
				symResRel.found && symResRel.symbols[0].content.includes("def helper_function_15"),
				{ found: symResRel.found, symbols: symResRel.symbols }
			);
			logPass("Targeted symbol extraction passed (relative path)!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
