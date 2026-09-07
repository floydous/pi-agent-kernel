// Section 35: LSP Reference Snippets & Seam Tests Suite

import { runSection } from "../_setup";
import { testAntiTruncationSnippet, testPathUriConversion } from "./snippet_windowing_test";

export async function runSection35(): Promise<void> {
	await runSection("35. LSP Reference Snippets & Seam Tests Suite", () => {
		testAntiTruncationSnippet();
		testPathUriConversion();
	});
}

runSection35().catch((err) => {
	console.error(err);
	process.exit(1);
});
