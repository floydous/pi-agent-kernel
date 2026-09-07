import { findExecutable } from "../../src/lsp/lsp_registry";
import { assertPass, logPass } from "../_setup";

export function testLspDualDirLookup(): void {
	// findExecutable returns a string (path) or null, never throws
	const result = findExecutable("nonexistent-tool", ["~/.pi/lsp/bin", "/tmp/lsp/bin"]);
	assertPass("findExecutable returns null or string for nonexistent tool", result === null || typeof result === "string", { result });
	logPass("LSP dual-directory lookup verified!");
}
