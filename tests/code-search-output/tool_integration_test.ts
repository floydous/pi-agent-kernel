import assert from "node:assert/strict";
import { registerCodeSearchTool } from "../../src/tools/code_search_tool";
import { logPass } from "../_setup";

interface MockHit {
	chunk: {
		id: string;
		absolutePath: string;
		filePath: string;
		startLine: number;
		endLine: number;
		kind: string;
		symbolName: string;
		breadcrumb: string;
		content: string;
		signature: string;
	};
	rrfScore: number;
	signal: "lexical";
	matches: string[];
}

function makeHit(filePath: string, content: string): MockHit {
	return {
		chunk: {
			id: `${filePath}:1-3#run`,
			absolutePath: `/tmp/${filePath}`,
			filePath,
			startLine: 1,
			endLine: 3,
			kind: "function",
			symbolName: "run",
			breadcrumb: `// [File: ${filePath}] > [FUNCTION: run]`,
			content,
			signature: "fn run()",
		},
		rrfScore: 1,
		signal: "lexical",
		matches: ["run"],
	};
}

export async function testToolIntegration(): Promise<void> {
	let registeredTool: any;
	const updates: any[] = [];
	const hit = makeHit("src/run.rs", "fn run() {\n  return;\n}");
	const scopeValues: string[] = [];

	const fakePi: any = {
		registerTool(tool: any) {
			if (tool.name === "code_search") registeredTool = tool;
		},
	};
	const fakeDeps: any = {
		getSessionId: () => "code-search-output-test",
		getSearchIndex: () => ({
			search: async (_query: string, options: any) => {
				scopeValues.push(options.scope);
				return [hit];
			},
		}),
	};

	registerCodeSearchTool(fakePi, fakeDeps);
	assert(registeredTool, "code_search tool must be registered");
	const result = await registeredTool.execute(
		"tool-call-1",
		{ query: "run", mode: "full" },
		undefined,
		(update: any) => updates.push(update),
		{ cwd: "/tmp" },
	);
	const text = result.content.find((item: any) => item.type === "text")?.text ?? "";
	assert(text.includes("return;"));
	assert.equal(result.details.requestedMode, "full");
	assert.equal(result.details.scope, "code");
	assert(updates.length > 0);
	assert.deepEqual(scopeValues, ["code"]);

	const invalid = await registeredTool.execute(
		"tool-call-2",
		{ query: "run", mode: "invalid" },
		undefined,
		undefined,
		{ cwd: "/tmp" },
	);
	assert.equal(invalid.isError, true);
	assert.match(invalid.content[0].text, /Invalid mode/);

	logPass("code_search tool mode and scope integration verified!");
}

export async function run(): Promise<void> {
	await testToolIntegration();
}
