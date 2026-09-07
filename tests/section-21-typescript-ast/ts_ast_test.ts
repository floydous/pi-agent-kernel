import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
} from "../../src/retrieval/ast_search";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testTypescriptAst(): Promise<void> {
	const ws = createTestWorkspace("ts_ast_");
	try {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".ts"]);

		const tsSrcDir = path.join(ws.tempDir, "src", "engine");
		fs.mkdirSync(tsSrcDir, { recursive: true });

		const tsFilePath = path.join(tsSrcDir, "query_runner.ts");
		fs.writeFileSync(
			tsFilePath,
			`import { LspClient } from "./lsp_client";

export interface QueryOptions {
    timeoutMs?: number;
    maxRetries?: number;
}

export class QueryRunner<T = any> {
    private readonly endpoint: string;

    constructor(endpoint: string) {
        this.endpoint = endpoint;
    }

    public async executeQuery(
        queryText: string,
        options: QueryOptions = {},
    ): Promise<T[]> {
        const pathDepth = (queryText.match(/\\//g) || []).length * 0.1;
        return [] as T[];
    }
}

export const createRunner = (
    url: string,
    port: number = 8080,
): QueryRunner => {
    return new QueryRunner(url);
};
`,
			"utf8",
		);

		const tsDocSyms = extractDocumentSymbols(tsFilePath);
		const symNames = tsDocSyms.map((s) => s.name);
		assertPass(
			"TypeScript Document Symbols include QueryOptions, QueryRunner, createRunner",
			symNames.includes("QueryOptions") &&
				symNames.includes("QueryRunner") &&
				symNames.includes("createRunner"),
			{ tsDocSyms },
		);
		assertPass(
			"TypeScript false-positive defense: pathDepth is not a top-level symbol",
			!symNames.includes("pathDepth"),
			{ symNames },
		);

		const tsParamHover = extractLocalSymbolHover(tsFilePath, 16, 12, "options");
		assertPass(
			"TypeScript multi-line parameter hover for 'options'",
			!!tsParamHover && tsParamHover.includes("options"),
			{ tsParamHover },
		);

		const tsRunnerRefs = findSymbolReferences(ws.tempDir, "QueryRunner");
		assertPass(
			"TypeScript symbol references for QueryRunner (>= 2 hits)",
			tsRunnerRefs.length >= 2,
			{ tsRunnerRefs },
		);

		logPass("TypeScript AST extraction, false-positive defense, hover, and references passed!");
	} finally {
		ws.cleanup();
	}
}
