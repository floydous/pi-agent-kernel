import { registerAstSearchTool } from "../../src/tools/ast_search_tool";
import { globalEpistemicGuard } from "../../src/safety/epistemic_guard";
import assert from "node:assert/strict";
import { logPass } from "../_setup";

export async function testToolIntegrationWithEpistemicGuard(): Promise<void> {
	let registeredTool: any = null;
	const fakePi: any = {
		registerTool: (tool: any) => {
			if (tool.name === "ast_search") {
				registeredTool = tool;
			}
		},
	};
	const fakeDeps: any = {
		getSessionId: () => "test-session-s38",
	};

	registerAstSearchTool(fakePi, fakeDeps);
	assert(registeredTool, "ast_search tool must be registered");
	if (!registeredTool) return; // narrows the type for ts strictness

	const ctx = { cwd: process.cwd() };

	// Instrument the guard spy
	let guardCallCount = 0;
	const originalRecordFileSearched = globalEpistemicGuard.recordFileSearched.bind(globalEpistemicGuard);
	globalEpistemicGuard.recordFileSearched = (...args: any[]) => {
		guardCallCount++;
		return originalRecordFileSearched(...(args as [any, any, any, any]));
	};

	// Run the tool against a known file
	const res = await registeredTool.execute(
		"call-s38",
		{ filePattern: "src/lsp/lsp_formatter.ts", kind: "function" },
		undefined,
		() => {},
		ctx
	);

	assert.ok(res.content && res.content[0]);
	const text = res.content[0].text;
	assert.ok(text.startsWith("src/lsp/lsp_formatter.ts"));
	assert.strictEqual((text.match(/src\/lsp\/lsp_formatter\.ts/g) || []).length, 1);
	assert.ok(text.includes("[function]"));
	assert.ok(res.details.count > 0);

	// Epistemic guard must record EVERY raw result, not just displayed ones
	assert.strictEqual(
		guardCallCount,
		res.details.count,
		`Epistemic guard must record every raw result; got ${guardCallCount} for ${res.details.count} results`
	);

	// Restore spy
	globalEpistemicGuard.recordFileSearched = originalRecordFileSearched;

	// No-results path
	const emptyRes = await registeredTool.execute(
		"call-s38-empty",
		{ name: "NonExistentSymbolxyz12345" },
		undefined,
		() => {},
		ctx
	);
	assert.strictEqual(emptyRes.details.count, 0);
	assert.ok(emptyRes.content[0].text.includes("No AST symbols found"));

	logPass("Section 38: Tool integration with epistemic guard recording verified!");
}
