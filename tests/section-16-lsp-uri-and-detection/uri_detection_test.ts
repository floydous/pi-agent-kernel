import * as path from "node:path";
import { pathToUri, uriToPath, detectLanguageFromPath, findWorkspaceRoot } from "../../src/lsp";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testLspUriAndDetection(): void {
	const ws = createTestWorkspace("lsp_uri_");
	try {
		const samplePath = path.resolve(ws.tempDir, "calculator.py");
		const sampleUri = pathToUri(samplePath);
		const recoveredPath = uriToPath(sampleUri);
		assertPass("URI to Path roundtrip preserves absolute path", path.resolve(recoveredPath) === samplePath, {
			samplePath,
			sampleUri,
			recoveredPath,
		});

		const detectedLang = detectLanguageFromPath(samplePath);
		assertPass("Language detection for .py returns 'python'", detectedLang === "python", { samplePath, detectedLang });

		const root = findWorkspaceRoot(ws.tempDir);
		assertPass("Workspace root returns a non-empty string", typeof root === "string" && root.length > 0, { root });

		logPass("LSP URI/path, language detection, and workspace root verified!");
	} finally {
		ws.cleanup();
	}
}
