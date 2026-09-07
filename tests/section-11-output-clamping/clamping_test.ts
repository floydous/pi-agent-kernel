import * as fs from "node:fs";
import { clampCommandOutput } from "../../src/safety/output_clamper";
import { assertPass, logPass } from "../_setup";

export function testMinifiedLineClamping(): void {
	const minifiedLine = "const bundle = {" + "x:1,".repeat(10000) + "};";
	const clamped = clampCommandOutput(minifiedLine, "grep -rn bundle .", { maxLineLength: 300 });

	assertPass("Minified line marked as truncated", clamped.truncated === true, { clamped });
	assertPass("Clamped output stays under 1000 bytes", clamped.text.length <= 1000, { clamped });
	assertPass("Clamped output references omitted chars", clamped.text.includes("chars omitted"), { clamped });

	if (clamped.spilloverPath) {
		assertPass("Spillover path exists on disk", fs.existsSync(clamped.spilloverPath), { spilloverPath: clamped.spilloverPath });
		try { fs.unlinkSync(clamped.spilloverPath); } catch {}
	}
	logPass(`Minified 1-line clamping verified (40 KB line clamped to ${clamped.text.length} bytes)!`);
}

export function testMatchFloodVerticalCapping(): void {
	const matchFlood = Array.from({ length: 150 }, (_, i) => `src/file_${i}.ts:42: const item_${i} = true;`).join("\n");
	const clamped = clampCommandOutput(matchFlood, "find . -name '*.ts'", { maxLines: 40 });

	assertPass("Match flood is truncated", clamped.truncated === true, { clamped });
	assertPass("Clamped to exactly 40 lines", clamped.shownLines === 40, { clamped });
	assertPass("Head of flood preserved", clamped.text.includes("src/file_0.ts"), { clamped });
	assertPass("Tail of flood preserved", clamped.text.includes("src/file_149.ts"), { clamped });
	assertPass("Footer reports omitted lines", clamped.text.includes("110 lines omitted"), { clamped });
	assertPass("Footer reports total vs shown", clamped.text.includes("Truncated: 40/150 lines"), { clamped });

	if (clamped.spilloverPath) {
		try { fs.unlinkSync(clamped.spilloverPath); } catch {}
	}
	logPass("Match flood vertical capping verified (150 lines capped to 40 lines head+tail with footer)!");
}
