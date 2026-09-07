// Section 36: Polyglot Tree-Sitter WASM Engine End-to-End Suite
// Modular tests for engine initialization, language loading, and end-to-end symbol extraction.

import { runSection } from "../_setup";
import { testEngineInitAndLoad } from "./engine_init_test";
import { testPolyglotEndToEnd } from "./end_to_end_test";

export async function runSection36(): Promise<void> {
	await runSection("36. Polyglot Tree-Sitter WASM Engine End-to-End Suite", async () => {
		await testEngineInitAndLoad();
		await testPolyglotEndToEnd();
	});
}

runSection36().catch((err) => {
	console.error(err);
	process.exit(1);
});
