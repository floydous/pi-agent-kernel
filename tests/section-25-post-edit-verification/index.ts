// Section 25: Compact Post-Edit Verification Suite

import { runSection } from "../_setup";
import { testCleanEditOutput } from "./clean_edit_test";
import { testFailureOutput } from "./failure_test";
import { testVerifyEditedFile } from "./verify_edited_file_test";

export async function runSection25(): Promise<void> {
	await runSection("25. Compact Post-Edit Verification Suite", async () => {
		testCleanEditOutput();
		testFailureOutput();
		await testVerifyEditedFile();
	});
}

runSection25().catch((err) => {
	console.error(err);
	process.exit(1);
});
