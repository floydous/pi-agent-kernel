// Tool Output Interception & Width Clamping Suite

import { runSuite } from "../_setup";
import { testDiscoveryCommandDetection } from "./discovery_command_test";
import { testMinifiedLineClamping, testMatchFloodVerticalCapping } from "./clamping_test";
import { testByteBudgetEnforcement, testFailedWriteDoesNotAdvertisePointer } from "./byte_budget_test";
import { runHostTruncationDedupTests } from "./host_truncation_dedup_test";
import { testEfficiencyDefaults } from "./efficiency_calibration_test";
import { testDiagnosticWindowRetention } from "./diagnostic_window_test";
export async function run(): Promise<void> {
	await runSuite("Tool Output Interception & Width Clamping Suite", () => {
		testDiscoveryCommandDetection();
		testMinifiedLineClamping();
		testMatchFloodVerticalCapping();
		testByteBudgetEnforcement();
		testFailedWriteDoesNotAdvertisePointer();
		testEfficiencyDefaults();
		testDiagnosticWindowRetention();
		runHostTruncationDedupTests();
	});
}

