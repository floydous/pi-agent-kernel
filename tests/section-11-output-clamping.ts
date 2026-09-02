// Section 11: Tool Output Interception & Width Clamping
// Tests clampCommandOutput and isDiscoveryCommand handle minified lines, match
// floods, and correctly identify search commands.

import * as fs from "node:fs";
import { clampCommandOutput, isDiscoveryCommand } from "../src/safety/output_clamper";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("11. Tool Output Interception & Width Clamping", () => {
		// Test 1: Discovery command recognition
		assertPass(
			"Discovery command detection passed",
			isDiscoveryCommand("grep -rn foo .") &&
				isDiscoveryCommand("rg 'export default'") &&
				!isDiscoveryCommand("pytest tests/")
		);
		logPass("Discovery command detection passed!");

		// Test 2: Minified 1-line explosion clamping
		const minifiedLine = "const bundle = {" + "x:1,".repeat(10000) + "};"; // 40,000+ chars on 1 line
		const clamped1 = clampCommandOutput(minifiedLine, "grep -rn bundle .", { maxLineLength: 300 });

		assertPass(
			"Minified line clamping works",
			clamped1.truncated &&
				clamped1.text.length <= 1000 &&
				!!clamped1.spilloverPath &&
				fs.existsSync(clamped1.spilloverPath) &&
				clamped1.text.includes("chars omitted"),
			{ clamped1 }
		);
		logPass(
			`Minified 1-line clamping verified (40 KB line clamped to ${clamped1.text.length} bytes, full raw output saved to ${clamped1.spilloverPath})!`
		);

		// Clean up spillover file
		try {
			if (clamped1.spilloverPath && fs.existsSync(clamped1.spilloverPath)) {
				fs.unlinkSync(clamped1.spilloverPath);
			}
		} catch {}

		// Test 3: Match flood vertical line capping (head + tail)
		const matchFlood = Array.from({ length: 150 }, (_, i) => `src/file_${i}.ts:42: const item_${i} = true;`).join("\n");
		const clamped2 = clampCommandOutput(matchFlood, "find . -name '*.ts'", { maxLines: 40 });

		assertPass(
			"Match flood vertical capping works",
			clamped2.truncated &&
				clamped2.shownLines === 40 &&
				clamped2.text.includes("src/file_0.ts") &&
				clamped2.text.includes("src/file_149.ts") &&
				clamped2.text.includes("110 lines omitted") &&
				clamped2.text.includes("Truncated: 40/150 lines"),
			{ clamped2 }
		);
		logPass("Match flood vertical capping verified (150 lines capped to 40 lines head+tail with footer)!");

		try {
			if (clamped2.spilloverPath && fs.existsSync(clamped2.spilloverPath)) {
				fs.unlinkSync(clamped2.spilloverPath);
			}
		} catch {}
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
