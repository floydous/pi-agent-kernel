import * as fs from "node:fs";
import * as path from "node:path";
import { extractSymbolContent } from "../../src/retrieval/symbol_reader";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testMonolithicPythonFile(): void {
	const ws = createTestWorkspace("sym_reader_mono_");
	try {
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
		assertPass(
			"Targeted symbol extraction passed (absolute path)",
			symResAbs.found &&
				symResAbs.symbols.length === 1 &&
				symResAbs.symbols[0].content.includes("def _handle_via_http_relay_connect") &&
				symResAbs.symbols[0].content.includes("X-Relay-Token"),
			{ symResAbs }
		);

		// Test symbol extraction with relative path
		process.chdir(ws.tempDir);
		const symResRel = extractSymbolContent("proxy_server.py", "helper_function_15");
		assertPass(
			"Targeted symbol extraction passed (relative path)",
			symResRel.found && symResRel.symbols[0].content.includes("def helper_function_15"),
			{ symResRel }
		);

		logPass("Monolithic file targeted symbol reader passed!");
	} finally {
		ws.cleanup();
	}
}
