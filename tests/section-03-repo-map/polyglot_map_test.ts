import { computeRepoMap } from "../../src/retrieval/repomap";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export async function testPolyglotRepoMap(): Promise<void> {
	const ws = createPolyglotWorkspace("repomap_polyglot_");
	try {
		await TreeSitterEngine.getInstance().init();
		const map = computeRepoMap(ws.tempDir, 2048);

		// 1. Must contain entries across all major language files
		const expectedFiles = [
			"src/app.ts",
			"src/worker.rs",
			"src/router.go",
			"src/PaymentService.java",
			"src/OrderProcessor.cs",
			"src/solver.cpp",
			"src/report.rb",
			"src/CacheManager.php",
		];

		for (const file of expectedFiles) {
			assertPass(`Repo map contains file ${file}`, map.includes(file), { file, mapSnippet: map.slice(0, 300) });
		}

		// 2. Must contain symbols from diverse languages
		assertPass("Repo map contains TS AppServer", map.includes("AppServer"), { map });
		assertPass("Repo map contains Rust TaskWorker", map.includes("TaskWorker"), { map });
		assertPass("Repo map contains Java PaymentService", map.includes("PaymentService"), { map });
		assertPass("Repo map contains Go ServiceHandler", map.includes("ServiceHandler"), { map });

		logPass("Polyglot repository map ranking and extraction passed!");
	} finally {
		ws.cleanup();
	}
}
