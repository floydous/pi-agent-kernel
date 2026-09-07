// Section 24: End-to-End Extension API Lifecycle & Custom Prompt Suite

import { runSection } from "../_setup";
import { testExtensionRegistration } from "./registration_test";

export async function runSection24(): Promise<void> {
	await runSection("24. End-to-End Extension API Lifecycle & Custom Prompt Suite", () => {
		testExtensionRegistration();
	});
}

runSection24().catch((err) => {
	console.error(err);
	process.exit(1);
});
