import { parseToml, stringifyToml, loadKernelConfig } from "../../src/config";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testTomlParseAndStringify(): void {
	const ws = createTestWorkspace("toml_cfg_");
	try {
		const sampleToml = `
[retrieval]
default_profile = "full"
repo_map_budget = 2048
max_search_results = 8

[safety]
enable_epistemic_guard = false
max_line_length = 450

[ui]
enable_pastel_footer = false
`;

		const parsed: any = parseToml(sampleToml);
		assertPass("parseToml returns an object", typeof parsed === "object" && parsed !== null, { parsed });
		assertPass("parsed.retrieval.default_profile === 'full'", parsed.retrieval?.default_profile === "full", { parsed });
		assertPass("parsed.retrieval.repo_map_budget === 2048", parsed.retrieval?.repo_map_budget === 2048, { parsed });
		assertPass("parsed.safety.enable_epistemic_guard === false", parsed.safety?.enable_epistemic_guard === false, { parsed });
		assertPass("parsed.ui.enable_pastel_footer === false", parsed.ui?.enable_pastel_footer === false, { parsed });

		// stringifyToml roundtrip
		const stringified = stringifyToml(parsed);
		assertPass("stringifyToml produces a non-empty string", typeof stringified === "string" && stringified.length > 0, { stringified });
		const reparsed: any = parseToml(stringified);
		assertPass("stringifyToml roundtrip preserves default_profile", reparsed.retrieval?.default_profile === "full", { reparsed });

		// loadKernelConfig from a directory
		const config = loadKernelConfig(ws.tempDir);
		assertPass("loadKernelConfig returns an object (possibly empty)", typeof config === "object" && config !== null, { config });

		logPass("TOML parse, stringify, and loadKernelConfig verified!");

		// Adversarial Prototype Pollution Verification
		const maliciousToml = `
[__proto__]
polluted = "yes"

[constructor.prototype]
polluted2 = "yes"

[retrieval]
__proto__ = "polluted3"
"constructor" = "polluted4"
"prototype" = "polluted5"
default_profile = "lean"
`;
		const parsedMalicious: any = parseToml(maliciousToml);
		assertPass("Root object has null prototype or is clean", Object.getPrototypeOf(parsedMalicious) === null);
		assertPass("Object.prototype.polluted is undefined", ({} as any).polluted === undefined);
		assertPass("Object.prototype.polluted2 is undefined", ({} as any).polluted2 === undefined);
		assertPass("Object.prototype.polluted3 is undefined", ({} as any).polluted3 === undefined);
		assertPass("Valid fields are preserved", parsedMalicious.retrieval?.default_profile === "lean");
		logPass("TOML prototype pollution resistance verified!");
	} finally {
		ws.cleanup();
	}
}
