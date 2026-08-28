import { checkSyntax } from "./git-verify";

export type VerificationState =
	| "clean"
	| "failed"
	| "findings"
	| "timeout"
	| "not run"
	| "unavailable"
	| "inconclusive";

export interface DiagnosticFinding {
	line?: number;
	message: string;
	severity?: "error" | "warning" | "info";
}

export interface DiagnosticVerification {
	state: VerificationState;
	findings: DiagnosticFinding[];
}

export interface PostEditVerification {
	edit: "applied" | "not applied";
	syntax: {
	state: VerificationState;
	message?: string;
	};
	diagnostic: DiagnosticVerification;
	tests: "not run";
}

export interface DiagnosticCheck {
	state: VerificationState;
	findings?: DiagnosticFinding[];
}

const LABEL_ORDER = ["edit", "diagnostic", "syntax", "tests"] as const;

function compactMessage(message: string, maxLength = 240): string {
	const compact = message.replace(/\s+/g, " ").trim();
	return compact.length > maxLength
		? `${compact.slice(0, maxLength - 1)}…`
		: compact;
}

function diagnosticValue(result: DiagnosticVerification): string {
	if (result.findings.length === 0) return result.state;

	const counts = new Map<string, number>();
	for (const finding of result.findings) {
		const severity = finding.severity || "error";
		counts.set(severity, (counts.get(severity) || 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([severity, count]) => `${count} ${severity === "warning" ? "warn" : severity === "info" ? "info" : "err"}`)
		.join(",");
}

function verificationEntries(result: PostEditVerification): Array<[string, string]> {
	if (result.edit === "not applied") return [["edit", "not applied"]];
	return [
		["syntax", result.syntax.state],
		["diagnostic", diagnosticValue(result.diagnostic)],
		["tests", result.tests],
	];
}

/**
 * Render the default edit result in a compact, deterministic form.
 * Equal values are grouped to avoid repeating status text.
 */
export function renderPostEditVerification(
	result: PostEditVerification,
	reason?: string,
): string {
	const hasSyntaxFailure = result.syntax.state === "failed";
	const hasDiagnosticError = result.diagnostic.findings.some(
		(finding) => finding.severity === "error" || !finding.severity,
	);
	const hasDiagnosticWarning = result.diagnostic.findings.some(
		(finding) => finding.severity === "warning" || finding.severity === "info",
	);
	const overall =
		result.edit === "not applied" || hasSyntaxFailure || hasDiagnosticError
			? "FAIL!"
			: hasDiagnosticWarning
				? "WARN!"
				: "OK!";

	const groups = new Map<string, string[]>();
	for (const [label, value] of verificationEntries(result)) {
		const labels = groups.get(value) || [];
		labels.push(label);
		groups.set(value, labels);
	}

	const lines = [overall];
	for (const value of Array.from(groups.keys())) {
		const labels = LABEL_ORDER.filter((label) => groups.get(value)?.includes(label));
		lines.push(`${labels.join(",")}:${value}`);
	}

	if (reason) lines.push(`reason:${compactMessage(reason)}`);
	if (result.syntax.message) {
		lines.push(` -${compactMessage(result.syntax.message)}`);
	}
	for (const finding of result.diagnostic.findings.slice(0, 3)) {
		const line = finding.line === undefined ? "" : `line ${finding.line}: `;
		lines.push(` -${line}${compactMessage(finding.message)}`);
	}
	if (result.diagnostic.findings.length > 3) {
		lines.push(` -+${result.diagnostic.findings.length - 3} more`);
	}
	return lines.join("\n");
}

/** Run the cheap local syntax gate and an optional bounded diagnostic check. */
export function renderEditFailure(reason: string): string {
	return renderPostEditVerification(
		{
			edit: "not applied",
			syntax: { state: "not run" },
			diagnostic: { state: "not run", findings: [] },
			tests: "not run",
		},
		reason,
	);
}

export async function verifyEditedFile(
	filePath: string,
	diagnostics?: () => Promise<DiagnosticCheck>,
): Promise<PostEditVerification> {
	const syntax = checkSyntax(filePath);
	if (!syntax.valid) {
		return {
			edit: "applied",
			syntax: { state: "failed", message: syntax.error },
			diagnostic: { state: "not run", findings: [] },
			tests: "not run",
		};
	}

	let diagnostic: DiagnosticVerification = { state: "not run", findings: [] };
	if (diagnostics) {
		try {
			const result = await diagnostics();
			diagnostic = {
				state: result.state,
				findings: result.findings || [],
			};
		} catch (error) {
			diagnostic = {
				state: "inconclusive",
				findings: [{ message: error instanceof Error ? error.message : String(error), severity: "info" }],
			};
		}
	}

	return {
		edit: "applied",
		syntax: { state: "clean" },
		diagnostic,
		tests: "not run",
	};
}
