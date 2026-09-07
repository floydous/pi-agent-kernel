// Section 18: LSP Manager & Modals Suite

import { runSection } from "../_setup";
import { testLspManagerLifecycle } from "./manager_lifecycle_test";

export async function runSection18(): Promise<void> {
	await runSection("18. LSP Manager & Modals Suite", async () => {
		await testLspManagerLifecycle();
	});
}

runSection18().catch((err) => {
	console.error(err);
	process.exit(1);
});
