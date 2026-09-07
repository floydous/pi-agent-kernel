// Section 30: Recall Tool Decision Logic Suite

import { runSection } from "../_setup";
import { testValidRef, testInvalidRef, testWrongSession } from "./recall_test";

export async function runSection30(): Promise<void> {
	await runSection("30. Recall Tool Decision Logic Suite", () => {
		testValidRef();
		testInvalidRef();
		testWrongSession();
	});
}

runSection30().catch((err) => {
	console.error(err);
	process.exit(1);
});
