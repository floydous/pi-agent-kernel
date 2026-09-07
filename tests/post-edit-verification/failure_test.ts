import { renderPostEditVerification } from "../../src/editing/post_edit_verification";
import { assertPass, logPass } from "../_setup";

export function testFailureOutput(): void {
	// Failure case: shows the failure details
	const failure = renderPostEditVerification({
		edit: "applied",
		syntax: { state: "failed", error: "TS1005: semicolon expected" },
		diagnostic: { state: "clean", findings: [] },
	});
	assertPass("Syntax failure output is non-empty and contains 'Edit:' header", failure.length > 0 && failure.includes("Edit:") && failure.includes("Syntax Error"), { failure });

	// Diagnostic findings: shows the error with line info
	const diagnosticFailure = renderPostEditVerification({
		edit: "applied",
		syntax: { state: "clean" },
		diagnostic: {
			state: "findings",
			findings: [
				{ line: 42, column: 7, severity: "error", message: "Cannot find name 'foo'", source: "typescript" },
			],
		},
	});
	assertPass("Diagnostic failure shows line, severity, and message", diagnosticFailure.includes("42:7") && diagnosticFailure.includes("error") && diagnosticFailure.includes("Cannot find name 'foo'"), { diagnosticFailure });

	logPass("Post-edit verification failure outputs are descriptive!");
}
