import { computeRepoMap } from "../../src/retrieval/repomap";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export function testBudgetClamping(): void {
	const ws = createTestWorkspace("repomap_budget_");
	try {
		const smallBudget = 100;
		const mapSmall = computeRepoMap(ws.tempDir, smallBudget);
		assertPass("Repo map respects small budget constraint", mapSmall.length > 0 && mapSmall.length < 1500, {
			length: mapSmall.length,
		});

		const bigBudget = 4096;
		const mapBig = computeRepoMap(ws.tempDir, bigBudget);
		assertPass("Big budget provides equal or more symbols than small budget", mapBig.length >= mapSmall.length, {
			small: mapSmall.length,
			big: mapBig.length,
		});

		logPass("Budget clamping and token density verified!");
	} finally {
		ws.cleanup();
	}
}
