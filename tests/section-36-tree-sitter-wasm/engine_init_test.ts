import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { assertPass, logPass } from "../_setup";

export async function testEngineInitAndLoad(): Promise<void> {
	const engine = TreeSitterEngine.getInstance();
	const initSuccess = await engine.init();
	assertPass("TreeSitterEngine initialization succeeds", initSuccess);
	const allExts = engine.getSupportedExtensions();
	assertPass("Engine reports a non-empty list of supported extensions", allExts.length > 0, {
		allExts,
	});

	await engine.loadLanguages(allExts);
	assertPass("Engine loads all supported language grammars without throwing", true, {});

	logPass(`TreeSitterEngine initialized with ${allExts.length} active parsers!`);
}
