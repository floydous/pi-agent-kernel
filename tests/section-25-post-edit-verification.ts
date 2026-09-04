// Section 25: Compact post-edit verification output.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	renderPostEditVerification,
	verifyEditedFile,
} from "../src/editing/post_edit_verification";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("25. Compact Post-Edit Verification", async () => {
		const clean = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "clean" },
			diagnostic: { state: "clean", findings: [] },
		});
		assertPass(
			"Clean edit returns empty string to save tokens",
			clean === "",
			{ clean },
		);

		const inconclusive = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "clean" },
			diagnostic: { state: "inconclusive", findings: [] },
		});
		assertPass(
			"Inconclusive diagnostics with clean syntax returns clean empty string (no false alarms)",
			inconclusive === "",
			{ inconclusive },
		);

		const failure = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "clean" },
			diagnostic: {
				state: "findings",
				findings: [
					{
						line: 42,
						column: 15,
						message: "Property 'token' does not exist on type 'Session'",
						severity: "error",
					},
				],
			},
		});
		assertPass(
			"Diagnostic errors render in clean - [line:col] message format",
			failure ===
				"Edit: Applied\nDiagnostics (errors):\n  - [42:15] Property 'token' does not exist on type 'Session'",
			{ failure },
		);

		const warning = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "clean" },
			diagnostic: {
				state: "findings",
				findings: [{ line: 7, column: 3, message: "Deprecated API", severity: "warning" }],
			},
		});
		assertPass(
			"Warnings render in clean - [line:col] message format",
			warning ===
				"Edit: Applied\nDiagnostics (warnings):\n  - [7:3] Deprecated API",
			{ warning },
		);

		const unavailable = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "unavailable", message: "Runtime unavailable" },
			diagnostic: { state: "not run", findings: [] },
		});
		assertPass(
			"Unavailable syntax checks report as syntax error",
			unavailable.includes("Edit: Applied") && unavailable.includes("Syntax Error:"),
			{ unavailable },
		);

		const ws = createTestWorkspace();
		try {
			const valid = await verifyEditedFile(ws.calculatorPath);
			assertPass(
				"Valid edited file passes syntax verification",
				valid.syntax.state === "clean",
				{ valid },
			);
			assertPass(
				"Diagnostics are explicit when no ready LSP is supplied",
				valid.diagnostic.state === "not run",
				{ valid },
			);

			const brokenPath = path.join(ws.tempDir, "broken.py");
			fs.writeFileSync(brokenPath, "def broken_func(:\n", "utf8");
			const broken = await verifyEditedFile(brokenPath);
			assertPass(
				"Broken edited file fails syntax verification",
				broken.syntax.state === "failed",
				{ broken },
			);
			assertPass(
				"Syntax failure is not reported as a clean edit",
				renderPostEditVerification(broken).includes("Syntax Error:"),
				{ broken },
			);

			const invalidTypeScriptPath = path.join(ws.tempDir, "broken.ts");
			fs.writeFileSync(invalidTypeScriptPath, "const value = ;\n", "utf8");
			const invalidTypeScript = await verifyEditedFile(invalidTypeScriptPath);
			assertPass(
				"TypeScript parser catches invalid expressions",
				invalidTypeScript.syntax.state === "failed" &&
					!!invalidTypeScript.syntax.message?.includes("Expression expected"),
				{ invalidTypeScript },
			);
			assertPass(
				"Syntax compiler errors are rendered with details",
				renderPostEditVerification(invalidTypeScript).includes(
					"Expression expected",
				),
				{ invalidTypeScript },
			);
		} finally {
			ws.cleanup();
		}

		logPass("Compact post-edit verification output and syntax gate verified!");
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
