// Section 21: TypeScript Full AST Intelligence & Parameter Scope Hover

import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
} from "../src/retrieval/ast_search";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("21. TypeScript Full AST & Parameter Scope Hover", () => {
		const ws = createTestWorkspace();
		try {
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

			// Verify Document Symbols on TypeScript
			const tsDocSyms = extractDocumentSymbols(tsFilePath);
			const symNames = tsDocSyms.map((s) => s.name);
			assertPass(
				"TypeScript Document Symbols include QueryOptions, QueryRunner, createRunner",
				symNames.includes("QueryOptions") &&
					symNames.includes("QueryRunner") &&
					symNames.includes("createRunner"),
				{ tsDocSyms },
			);
			// Ensure variable assignment pathDepth is NOT falsely recognized as a function
			assertPass(
				"TypeScript false-positive defense: pathDepth is not a function symbol",
				!symNames.includes("pathDepth"),
				{ symNames },
			);
			logPass(
				`TypeScript document symbols verified (${tsDocSyms.length} symbol(s), zero false positives)!`,
			);

			// Verify hover on multi-line TypeScript parameter
			const tsParamHover = extractLocalSymbolHover(tsFilePath, 16, 12, "options");
			assertPass(
				"TypeScript multi-line parameter hover for 'options'",
				!!tsParamHover &&
					tsParamHover.includes("(parameter) options: QueryOptions"),
				{ tsParamHover },
			);
			logPass(
				"TypeScript multi-line parameter hover verified ('options: QueryOptions')!",
			);

			// Verify references across TypeScript workspace
			const tsRunnerRefs = findSymbolReferences(ws.tempDir, "QueryRunner");
			assertPass(
				"TypeScript symbol references for QueryRunner",
				tsRunnerRefs.length >= 2,
				{ tsRunnerRefs },
			);
			logPass(
				`TypeScript workspace references verified (${tsRunnerRefs.length} match(es) for QueryRunner)!`,
			);
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
