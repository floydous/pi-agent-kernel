import { renderPostEditVerification } from "../../src/editing/post_edit_verification";
import { assertPass, logPass } from "../_setup";

export function testCleanEditOutput(): void {
	// Clean edit: empty string to save tokens
	const clean = renderPostEditVerification({
		edit: "applied",
		syntax: { state: "clean" },
		diagnostic: { state: "clean", findings: [] },
	});
	assertPass("Clean edit returns empty string", clean === "", { clean });

	// Inconclusive diagnostics with clean syntax returns empty string (no false alarms)
	const inconclusive = renderPostEditVerification({
		edit: "applied",
		syntax: { state: "clean" },
		diagnostic: { state: "inconclusive", findings: [] },
	});
	assertPass("Inconclusive diagnostics with clean syntax returns empty", inconclusive === "", { inconclusive });

	logPass("Clean post-edit verification returns compact empty output!");
}
