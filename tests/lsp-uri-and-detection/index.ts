// LSP URI/Path, Language Detection, Workspace Root Suite

import { runSuite } from "../_setup";
import { testLspUriAndDetection } from "./uri_detection_test";

export async function run(): Promise<void> {
	await runSuite("LSP URI/Path, Language Detection, Workspace Root Suite", () => {
		testLspUriAndDetection();
	});
}

