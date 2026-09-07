// Tool Output Interception & Width Clamping Suite

import { runSuite } from "../_setup";
import { testDiscoveryCommandDetection } from "./discovery_command_test";
import { testMinifiedLineClamping, testMatchFloodVerticalCapping } from "./clamping_test";

export async function run(): Promise<void> {
	await runSuite("Tool Output Interception & Width Clamping Suite", () => {
		testDiscoveryCommandDetection();
		testMinifiedLineClamping();
		testMatchFloodVerticalCapping();
	});
}

