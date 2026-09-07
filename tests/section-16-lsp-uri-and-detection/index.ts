// Section 16: LSP URI/Path, Language Detection, Workspace Root Suite

import { runSection } from "../_setup";
import { testLspUriAndDetection } from "./uri_detection_test";

export async function runSection16(): Promise<void> {
	await runSection("16. LSP URI/Path, Language Detection, Workspace Root Suite", () => {
		testLspUriAndDetection();
	});
}

runSection16().catch((err) => {
	console.error(err);
	process.exit(1);
});
