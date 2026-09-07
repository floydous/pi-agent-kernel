// Session File Repair & Self-Healing Suite

import { runSuite } from "../_setup";
import { testSessionRepair } from "./repair_test";

export async function run(): Promise<void> {
	await runSuite("Session File Repair & Self-Healing Suite", () => {
		testSessionRepair();
	});
}

