// Unified Footer Formatting & Layout Suite

import { runSuite } from "../_setup";
import { testUnifiedFooter } from "./footer_test";

export async function run(): Promise<void> {
	await runSuite("Unified Footer Formatting & Layout Suite", () => {
		testUnifiedFooter();
	});
}

