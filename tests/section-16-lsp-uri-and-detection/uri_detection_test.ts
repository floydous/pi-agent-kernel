import * as path from "node:path";
import * as fs from "node:fs";
import { pathToUri, uriToPath, detectLanguageFromPath, findWorkspaceRoot, normalizeUri } from "../../src/lsp";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testLspUriAndDetection(): void {
	const ws = createTestWorkspace("lsp_uri_");
	try {
		// 1. URI to Path roundtrip with strict equality
		const samplePath = path.resolve(ws.tempDir, "calculator.py");
		const sampleUri = pathToUri(samplePath);
		assertPass("pathToUri produces a file:// scheme URI", sampleUri.startsWith("file://"), { sampleUri });
		const recoveredPath = uriToPath(sampleUri);
		assertPass("URI → Path roundtrip preserves absolute path", path.resolve(recoveredPath) === samplePath, {
			samplePath,
			sampleUri,
			recoveredPath,
		});

		// 2. Windows-style paths and backslashes normalized correctly
		const windowsPath = "C:\\Users\\dev\\project\\src\\file.ts";
		const windowsUri = pathToUri(windowsPath);
		assertPass("Windows path → URI has forward-slashes and file:// scheme", windowsUri.startsWith("file://") && !windowsUri.includes("\\"), { windowsUri });

		// 3. Language detection across multiple languages
		const langTests: Array<{ file: string; expected: string }> = [
			{ file: "a.py", expected: "python" },
			{ file: "a.ts", expected: "typescript" },
			{ file: "a.rs", expected: "rust" },
			{ file: "a.go", expected: "go" },
			{ file: "a.java", expected: "java" },
			{ file: "a.cs", expected: "csharp" },
		];
		for (const lt of langTests) {
			const detected = detectLanguageFromPath(path.resolve(ws.tempDir, lt.file));
			assertPass(`Language detection for ${lt.file} returns '${lt.expected}'`, detected === lt.expected, { detected, expected: lt.expected });
		}

		// 4. Unknown extension returns null/undefined
		const unknownLang = detectLanguageFromPath(path.resolve(ws.tempDir, "file.xyz"));
		assertPass("Unknown extension returns null/undefined", unknownLang === null || unknownLang === undefined, { unknownLang });

		// 5. findWorkspaceRoot returns a non-empty string for a real workspace
		const root = findWorkspaceRoot(ws.tempDir);
		assertPass("Workspace root returns a non-empty absolute path", typeof root === "string" && root.length > 0 && path.isAbsolute(root), { root });

		// 6. normalizeUri: idempotent on already-normalized URIs
		const normUri = normalizeUri(sampleUri);
		assertPass("normalizeUri on a normalized URI returns the same string", normUri === sampleUri, { normUri, sampleUri });

		logPass("LSP URI/path, language detection, normalizeUri, and workspace root deeply verified!");
	} finally {
		ws.cleanup();
	}
}
