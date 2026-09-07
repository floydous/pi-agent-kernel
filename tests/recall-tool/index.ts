// Recall Tool Decision Logic Suite

import { runSuite } from "../_setup";
import { testValidRef, testInvalidRef, testWrongSession } from "./recall_test";

export async function run(): Promise<void> {
	await runSuite("Recall Tool Decision Logic Suite", () => {
		testValidRef();
		testInvalidRef();
		testWrongSession();
	});
}

