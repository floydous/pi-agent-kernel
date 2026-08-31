// Section 23: Hierarchical TOML Configuration Loader
// Tests parseToml, stringifyToml, and loadKernelConfig.

import { parseToml, stringifyToml, loadKernelConfig } from "../src/config";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("23. Hierarchical TOML Configuration Loader", () => {
		const ws = createTestWorkspace();
		try {
			const sampleToml = `
[retrieval]
default_profile = "full"
repo_map_budget = 2048
max_search_results = 8

[safety]
enable_epistemic_guard = false
max_line_length = 450

[lsp]
idle_timeout_ms = 120000
`;

			const parsedConfig = parseToml(sampleToml) as any;
			assertPass(
				"TOML parser verification",
				parsedConfig.retrieval?.default_profile === "full" &&
					parsedConfig.retrieval?.repo_map_budget === 2048 &&
					parsedConfig.safety?.enable_epistemic_guard === false &&
					parsedConfig.safety?.max_line_length === 450 &&
					parsedConfig.lsp?.idle_timeout_ms === 120000,
				{ parsedConfig }
			);
			logPass("Zero-dependency TOML parser verified!");

			const serialized = stringifyToml(parsedConfig);
			const roundtripped = parseToml(serialized) as any;
			assertPass(
				"TOML serializer roundtrip",
				roundtripped.retrieval?.default_profile === "full" && roundtripped.retrieval?.repo_map_budget === 2048,
				{ roundtripped }
			);
			logPass("Zero-dependency TOML serializer roundtrip verified!");

			const kernelCfg = loadKernelConfig(ws.tempDir);
			assertPass(
				"loadKernelConfig structure is valid",
				!!kernelCfg.retrieval && !!kernelCfg.safety && !!kernelCfg.lsp && !!kernelCfg.ui,
				{ kernelCfg }
			);
			logPass("Hierarchical kernel configuration loader verified!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
