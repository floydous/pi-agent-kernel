import { checkSyntax } from "./syntax-verify";

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
	column?: number;
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
}

export interface DiagnosticCheck {
	state: VerificationState;
	findings?: DiagnosticFinding[];
}

const LABEL_ORDER = ["edit", "diagnostic", "syntax"] as const;

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
		.map(
			([severity, count]) =>
				`${count} ${severity === "warning" ? "warn" : severity === "info" ? "info" : "err"}`,
		)
		.join(",");
}

function verificationEntries(
	result: PostEditVerification,
): Array<[string, string]> {
	if (result.edit === "not applied") return [["edit", "not applied"]];
	return [
		["syntax", result.syntax.state],
		["diagnostic", diagnosticValue(result.diagnostic)],
	];
}

/**
 * Render the default edit result in a clean, indented form.
 */
export function renderPostEditVerification(
	result: PostEditVerification,
	reason?: string,
): string {
	const hasSyntaxFailure = result.syntax.state === "failed";
	const hasSyntaxUncertainty = [
		"unavailable",
		"inconclusive",
		"timeout",
	].includes(result.syntax.state);
	const hasDiagnosticError = result.diagnostic.findings.some(
		(finding) => finding.severity === "error" || !finding.severity,
	);
	const hasDiagnosticWarning = result.diagnostic.findings.some(
		(finding) => finding.severity === "warning" || finding.severity === "info",
	);

	// Token density: return empty string on completely clean verification
	if (
		result.edit === "applied" &&
		!hasSyntaxFailure &&
		!hasDiagnosticError &&
		!hasDiagnosticWarning &&
		(!hasSyntaxUncertainty || result.syntax.state === "clean")
	) {
		return "";
	}

	const lines: string[] = [];

	if (result.edit === "not applied") {
		lines.push("Edit: Not applied");
		lines.push("Reason:");
		if (reason) {
			lines.push(`  - ${compactMessage(reason)}`);
		}
		if (result.syntax.message && result.syntax.message !== reason) {
			lines.push(`  - ${compactMessage(result.syntax.message)}`);
		}
		return lines.join("\n");
	}

	// Edit was applied
	lines.push("Edit: Applied");

	if (hasSyntaxFailure || (hasSyntaxUncertainty && result.syntax.state !== "clean")) {
		lines.push("Syntax Error:");
		lines.push(`  - ${compactMessage(result.syntax.message || "Syntax validation failed")}`);
	}

	if (result.diagnostic.findings.length > 0) {
		const header = hasDiagnosticError ? "Diagnostics (errors):" : "Diagnostics (warnings):";
		lines.push(header);
		for (const finding of result.diagnostic.findings.slice(0, 5)) {
			const pos =
				finding.line !== undefined
					? finding.column !== undefined
						? `[${finding.line}:${finding.column}] `
						: `[${finding.line}] `
					: "";
			lines.push(`  - ${pos}${compactMessage(finding.message)}`);
		}
		if (result.diagnostic.findings.length > 5) {
			lines.push(`  - +${result.diagnostic.findings.length - 5} more`);
		}
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
			syntax: {
				state: syntax.status || "failed",
				message: syntax.error,
			},
			diagnostic: { state: "not run", findings: [] },
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
				findings: [
					{
						message: error instanceof Error ? error.message : String(error),
						severity: "info",
					},
				],
			};
		}
	}

	return {
		edit: "applied",
		syntax: { state: syntax.status || "clean" },
		diagnostic,
	};
}
