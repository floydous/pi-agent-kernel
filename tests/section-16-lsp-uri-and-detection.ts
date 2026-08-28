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
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
