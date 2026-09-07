// Section 23: Hierarchical TOML Configuration Loader Suite

import { runSection } from "../_setup";
import { testTomlParseAndStringify } from "./toml_test";

export async function runSection23(): Promise<void> {
	await runSection("23. Hierarchical TOML Configuration Loader Suite", () => {
		testTomlParseAndStringify();
	});
}

runSection23().catch((err) => {
	console.error(err);
	process.exit(1);
});
