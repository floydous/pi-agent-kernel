import { windowAround, pathToUri } from "../../src/lsp";
import { assertPass, logPass } from "../_setup";

export function testAntiTruncationSnippet(): void {
	const longSym = "SuperLongDescriptiveFunctionName";
	const sampleLine = "const prefix_val = some_object." + longSym + "({ option: 1 });";
	const startCol0 = sampleLine.indexOf(longSym);
	const endCol0 = startCol0 + longSym.length;

	const snippet = windowAround(sampleLine, startCol0, endCol0, 50);
	assertPass("Long identifier is never truncated in snippet", snippet.includes(longSym), { snippet });
	assertPass(
		"Snippet is bounded (with ellipsis or short line)",
		snippet.startsWith("... ") || snippet.endsWith(" ...") || snippet.length <= 60,
		{ length: snippet.length, snippet },
	);
	logPass("Anti-truncation snippet windowing verified!");
}

export function testPathUriConversion(): void {
	const uri = pathToUri("/abs/path/to/file.ts");
	assertPass("pathToUri produces a valid file:// URI", uri.startsWith("file://") && uri.includes("file.ts"), { uri });
}
