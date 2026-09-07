// Compact Post-Edit Verification Suite

import { runSuite } from "../_setup";
import { testCleanEditOutput } from "./clean_edit_test";
import { testFailureOutput } from "./failure_test";
import { testVerifyEditedFile } from "./verify_edited_file_test";

export async function run(): Promise<void> {
	await runSuite("Compact Post-Edit Verification Suite", async () => {
		testCleanEditOutput();
		testFailureOutput();
		await testVerifyEditedFile();
	});
}

