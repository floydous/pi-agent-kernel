// Section 16: LSP - URI/Path resolution, language detection, workspace root

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToUri, uriToPath, detectLanguageFromPath, findWorkspaceRoot } from "../src/lsp";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("16. LSP URI/Path, Language Detection, Workspace Root", () => {
		const ws = createTestWorkspace();
		try {
			// 1. Cross-platform URI resolution test
			const samplePath = path.resolve(ws.tempDir, "calculator.py");
			const sampleUri = pathToUri(samplePath);
			const recoveredPath = uriToPath(sampleUri);
			assertPass(
				"URI to Path conversion roundtrip",
				path.resolve(recoveredPath) === samplePath,
				{ samplePath, sampleUri, recoveredPath }
			);
			logPass("Cross-platform URI resolution roundtrip passed!");

			// 2. Language Detection & Workspace Root Finder
			const detectedLang = detectLanguageFromPath(samplePath);
			assertPass("Language detection for .py", detectedLang === "python", { samplePath, detectedLang });

			const wsRoot = findWorkspaceRoot(ws.tempDir, "python");
			assertPass("Workspace root finder", !!wsRoot && fs.existsSync(wsRoot), { tempDir: ws.tempDir, wsRoot });
			logPass("Language detection and workspace root resolution passed!");

			// 3. Fallback behavior for unsupported language extension
			const unsupportedPath = path.resolve(ws.tempDir, "notes.unknownext");
			assertPass("detectLanguageFromPath returns null for unknown extensions", detectLanguageFromPath(unsupportedPath) === null, { unsupportedPath });
			logPass("Unknown language extension gracefully returns null!");

			// 4. Executable validation behavior (shims without components return null)
			const { findExecutable } = require("../src/lsp/lsp_registry");
			const fakeDir = path.join(ws.tempDir, "mock_bin");
			fs.mkdirSync(fakeDir, { recursive: true });
			// Create a dummy broken rust-analyzer script that exits 1
			const fakeShim = path.join(fakeDir, process.platform === "win32" ? "rust-analyzer.bat" : "rust-analyzer");
			fs.writeFileSync(fakeShim, process.platform === "win32" ? "@exit 1" : "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			const foundBroken = findExecutable("rust-analyzer", [fakeDir]);
			// The broken script should not be returned as the candidate if it exits non-zero
			// (either null if no system RA, or real system RA if available, never the broken fakeShim)
			assertPass(
				"findExecutable rejects non-functional broken shims",
				foundBroken !== fakeShim,
				{ foundBroken, fakeShim }
			);
			logPass("findExecutable non-functional shim rejection verified!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
