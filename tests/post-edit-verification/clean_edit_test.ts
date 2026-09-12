import { renderPostEditVerification } from "../../src/editing/post_edit_verification";
import { assertPass, logPass } from "../_setup";

export function testCleanEditOutput(): void {
	// Clean edit: explicit success string so model does not doubt application
	const clean = renderPostEditVerification({
		edit: "applied",
		syntax: { state: "clean" },
		diagnostic: { state: "clean", findings: [] },
	});
	assertPass("Clean edit returns confirmation string", clean === "Successfully applied edit.", { clean });

	// Inconclusive diagnostics with clean syntax returns confirmation
	const inconclusive = renderPostEditVerification({
		edit: "applied",
		syntax: { state: "clean" },
		diagnostic: { state: "inconclusive", findings: [] },
	});
	assertPass("Inconclusive diagnostics with clean syntax returns confirmation", inconclusive === "Successfully applied edit.", { inconclusive });

	logPass("Clean post-edit verification returns confirmation output!");
}
