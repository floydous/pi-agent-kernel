// Polyglot Tree-Sitter WASM Engine End-to-End Suite
// Modular tests for engine initialization, language loading, and end-to-end symbol extraction.

import { runSuite } from "../_setup";
import { testEngineInitAndLoad } from "./engine_init_test";
import { testPolyglotEndToEnd } from "./end_to_end_test";

export async function run(): Promise<void> {
	await runSuite("Polyglot Tree-Sitter WASM Engine End-to-End Suite", async () => {
		await testEngineInitAndLoad();
		await testPolyglotEndToEnd();
	});
}

