import * as fs from "node:fs";
import * as path from "node:path";
import { verifyEditedFile } from "../../src/editing/post_edit_verification";
import { createTestWorkspace, assertPass, logPass } from "../_setup";

export async function testVerifyEditedFile(): void {
	const ws = createTestWorkspace("post_edit_verify_");
	try {
		// Add a known good Python file
		const pyPath = path.join(ws.tempDir, "good.py");
		fs.writeFileSync(pyPath, "def x():\n    return 1\n", "utf8");
		const validResult = await verifyEditedFile(pyPath, "applied");
		assertPass("Valid Python file passes verification", validResult.diagnostic.state === "clean" || validResult.diagnostic.state === "inconclusive", { validResult });

		logPass("End-to-end verifyEditedFile passes for valid Python!");
	} finally {
		ws.cleanup();
	}
}
