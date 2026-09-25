import { run as runOutputTests } from "./output_test";
import { testToolIntegration } from "./tool_integration_test";
import { testCodeOnlyIndexing } from "./scope_test";

export async function run(): Promise<void> {
	runOutputTests();
	await testToolIntegration();
	await testCodeOnlyIndexing();
}
