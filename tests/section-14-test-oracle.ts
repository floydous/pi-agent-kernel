// Section 14: Deterministic Test Oracle & Contract Verification
// Tests runOracle correctly reports pass/fail based on exit code.

import { runOracle } from "../src/safety/test_oracle";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("14. Deterministic Test Oracle & Contract Verification", async () => {
		const ws = createTestWorkspace();
		try {
			// Passing oracle execution
			const passingOracle = await runOracle("node -e \"process.exit(0)\"", { cwd: ws.tempDir });
			assertPass(
				"Passing oracle test passed",
				passingOracle.passed && passingOracle.exitCode === 0 && passingOracle.summary.includes("GREEN [VERIFIED]"),
				{ passingOracle }
			);

			// Failing oracle execution (exit code 1)
			const failingOracle = await runOracle("node -e \"console.error('Syntax failure'); process.exit(1)\"", { cwd: ws.tempDir });
			assertPass(
				"Failing oracle test fails correctly",
				!failingOracle.passed && failingOracle.exitCode === 1 && failingOracle.summary.includes("RED [EXIT 1]"),
				{ failingOracle }
			);

			logPass("Deterministic binary test oracle verified!");
		} finally {
			ws.cleanup();
		}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
