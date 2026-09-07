// LSP Reference Snippets & Seam Tests Suite

import { runSuite } from "../_setup";
import { testAntiTruncationSnippet, testPathUriConversion } from "./snippet_windowing_test";

export async function run(): Promise<void> {
	await runSuite("LSP Reference Snippets & Seam Tests Suite", () => {
		testAntiTruncationSnippet();
		testPathUriConversion();
	});
}

