// Hierarchical TOML Configuration Loader Suite

import { runSuite } from "../_setup";
import { testTomlParseAndStringify } from "./toml_test";

export async function run(): Promise<void> {
	await runSuite("Hierarchical TOML Configuration Loader Suite", () => {
		testTomlParseAndStringify();
	});
}

