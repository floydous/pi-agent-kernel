// LSP Manager & Modals Suite

import { runSuite } from "../_setup";
import { testLspManagerLifecycle } from "./manager_lifecycle_test";

export async function run(): Promise<void> {
	await runSuite("LSP Manager & Modals Suite", async () => {
		await testLspManagerLifecycle();
	});
}

