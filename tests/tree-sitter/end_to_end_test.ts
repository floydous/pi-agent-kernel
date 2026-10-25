import * as fs from "node:fs";
import * as path from "node:path";
import { extractFileTags } from "../../src/retrieval/tag_extractor";
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

		}
		logPass(`Polyglot end-to-end across ${POLYGLOT_CASES.length} languages verified!`);
	} finally {
		ws.cleanup();
	}
}
