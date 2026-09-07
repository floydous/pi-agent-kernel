// End-to-End Extension API Lifecycle & Custom Prompt Suite

import { runSuite } from "../_setup";
import { testExtensionRegistration } from "./registration_test";

export async function run(): Promise<void> {
	await runSuite("End-to-End Extension API Lifecycle & Custom Prompt Suite", () => {
		testExtensionRegistration();
	});
}

