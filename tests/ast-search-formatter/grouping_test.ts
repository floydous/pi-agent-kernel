import assert from "node:assert";
import type { AstQueryResult } from "../../src/retrieval/ast_search";
import { formatAstSearchResults } from "../../src/tools/ast_search_formatter";
import { logPass } from "../_setup";

export function testBasicGroupingAndLayout(): void {
	const rawResults: AstQueryResult[] = [
		{
			filePath: "src\\routes\\proxy.rs",
			name: "catch_all",
			kind: "function",
			line: 27,
			endLine: 369,
			signature: "fn catch_all(req: Request) -> Response",
		},
		{
			filePath: "src/models/user.ts",
			name: "User",
			kind: "class",
			line: 10,
			endLine: 45,
			signature: "class User",
		},
		{
			filePath: "src\\routes\\proxy.rs",
			name: "json_error",
			kind: "function",
			line: 373,
			endLine: 384,
			signature: "fn json_error(msg: &str) -> Response",
		},
	];

	const output = formatAstSearchResults(rawResults, false);

	const proxyMatches = output.match(/src\/routes\/proxy\.rs/g) || [];
	assert.strictEqual(proxyMatches.length, 1, "src/routes/proxy.rs should appear once");

	const userMatches = output.match(/src\/models\/user\.ts/g) || [];
	assert.strictEqual(userMatches.length, 1, "src/models/user.ts should appear once");

	const proxyIdx = output.indexOf("src/routes/proxy.rs");
	const userIdx = output.indexOf("src/models/user.ts");
	assert.ok(proxyIdx !== -1 && userIdx !== -1 && proxyIdx < userIdx, "File order must be preserved");

	assert.ok(output.includes("[function]\n- 27-369"), "Multi-symbol kind must have [kind] header and bulleted dash");
	assert.ok(output.includes("- 373-384"), "Second function must be bulleted under same header");

	assert.ok(output.includes("[class] 10-45"), "Singleton kind must be inline [class] 10-45");

	logPass("Basic hierarchical grouped layout verified!");
}
