// Section 11: Tool Output Interception & Width Clamping Suite

import { runSection } from "../_setup";
import { testDiscoveryCommandDetection } from "./discovery_command_test";
import { testMinifiedLineClamping, testMatchFloodVerticalCapping } from "./clamping_test";

export async function runSection11(): Promise<void> {
	await runSection("11. Tool Output Interception & Width Clamping Suite", () => {
		testDiscoveryCommandDetection();
		testMinifiedLineClamping();
		testMatchFloodVerticalCapping();
	});
}

runSection11().catch((err) => {
	console.error(err);
	process.exit(1);
});
