import { isDiscoveryCommand } from "../../src/safety/output_clamper";
import { assertPass, logPass } from "../_setup";

export function testDiscoveryCommandDetection(): void {
	// Discovery commands (grep, rg, find) should be detected
	assertPass("grep -rn is a discovery command", isDiscoveryCommand("grep -rn foo .") === true, {});
	assertPass("rg 'export default' is a discovery command", isDiscoveryCommand("rg 'export default'") === true, {});
	assertPass("pytest is not a discovery command", isDiscoveryCommand("pytest tests/") === false, {});
	logPass("Discovery command detection verified!");
}
