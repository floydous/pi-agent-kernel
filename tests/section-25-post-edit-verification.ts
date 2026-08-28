// Section 25: Compact post-edit verification output.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	renderPostEditVerification,
	verifyEditedFile,
} from "../editing/post_edit_verification";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("25. Compact Post-Edit Verification", async () => {
		const clean = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "clean" },
			diagnostic: { state: "clean", findings: [] },
			tests: "not run",
		});
		assertPass(
			"Equal clean statuses are merged",
			clean === "OK!\ndiagnostic,syntax:clean\ntests:not run",
			{ clean },
		);

		const failure = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "clean" },
			diagnostic: {
				state: "findings",
				findings: [
					{
						line: 42,
						message: "Property 'token' does not exist on type 'Session'",
						severity: "error",
					},
				],
			},
			tests: "not run",
		});
		assertPass(
			"Diagnostic errors remain compact and actionable",
			failure ===
				"FAIL!\nsyntax:clean\ndiagnostic:1 err\ntests:not run\n -line 42: Property 'token' does not exist on type 'Session'",
			{ failure },
		);

		const warning = renderPostEditVerification({
			edit: "applied",
			syntax: { state: "clean" },
			diagnostic: {
				state: "findings",
				findings: [{ line: 7, message: "Deprecated API", severity: "warning" }],
			},
			tests: "not run",
		});
		assertPass(
			"Warnings are distinguished without verbose output",
			warning ===
				"WARN!\nsyntax:clean\ndiagnostic:1 warn\ntests:not run\n -line 7: Deprecated API",
			{ warning },
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
				renderPostEditVerification(broken).startsWith("FAIL!"),
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
				renderPostEditVerification(invalidTypeScript).includes("Expression expected"),
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
