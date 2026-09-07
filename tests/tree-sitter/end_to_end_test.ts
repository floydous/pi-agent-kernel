import * as fs from "node:fs";
import * as path from "node:path";
import { extractFileTags } from "../../src/retrieval/repomap";
import { searchAstSymbols } from "../../src/retrieval/ast_search";
import { extractSymbolContent } from "../../src/retrieval/symbol_reader";
import { createTestWorkspace, assertPass, logPass } from "../_setup";
import { POLYGLOT_CASES } from "./polyglot_cases";

export async function testPolyglotEndToEnd(): Promise<void> {
	const ws = createTestWorkspace("polyglot_e2e_");
	try {
		for (const testCase of POLYGLOT_CASES) {
			const fullPath = path.join(ws.tempDir, testCase.fileName);
			fs.writeFileSync(fullPath, testCase.code, "utf8");

			// 1. extractFileTags
			const tags = extractFileTags(fullPath, testCase.code);
			const tagDef = tags.definitions.find((d) => d.name === testCase.expectedSymbol);
			assertPass(
				`[${testCase.lang}] extractFileTags finds ${testCase.expectedSymbol}`,
				!!tagDef && tagDef.kind === testCase.expectedKind,
				{ expected: testCase.expectedSymbol, tagDef }
			);

			// 2. searchAstSymbols
			const searchHits = searchAstSymbols(ws.tempDir, {
				name: testCase.expectedSymbol,
				exactMatch: true,
			});
			assertPass(
				`[${testCase.lang}] searchAstSymbols resolves ${testCase.expectedSymbol}`,
				searchHits.length > 0 &&
				searchHits.every((hit) => hit.name === testCase.expectedSymbol && hit.filePath === testCase.fileName) &&
				searchHits.filter((hit) => hit.kind === testCase.expectedKind).length === 1,
				{ searchHits }
			);

			// 3. extractSymbolContent
			const symResult = extractSymbolContent(fullPath, testCase.expectedSymbol);
			assertPass(
				`[${testCase.lang}] extractSymbolContent extracts ${testCase.expectedSymbol}`,
				symResult.found === true &&
				symResult.symbols.length >= 1 &&
				symResult.symbols.every((symbol) => symbol.name === testCase.expectedSymbol && symbol.content.includes(testCase.expectedSymbol) && symbol.startLine >= 1 && symbol.endLine >= symbol.startLine),
				{ symResult }
			);
		}
		logPass(`Polyglot end-to-end across ${POLYGLOT_CASES.length} languages verified!`);
	} finally {
		ws.cleanup();
	}
}
