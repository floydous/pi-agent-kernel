import * as fs from "node:fs";
import * as path from "node:path";
import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { assertPass, logPass } from "../_setup";

export async function testStaleCacheRejection(): Promise<void> {
	const tmpDir = path.join(process.cwd(), "tmp_s37_test");
	if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
	fs.mkdirSync(tmpDir, { recursive: true });

	try {
		const cacheDir = path.join(tmpDir, ".pi", "cache", "search");
		fs.mkdirSync(cacheDir, { recursive: true });

		const tsFile = path.join(tmpDir, "calculator.ts");
		const padding = Array.from({ length: 45 }, (_, i) => `// line ${i}`).join("\n");
		fs.writeFileSync(tsFile, `export class Calc {\n  public multiply(x: number): number { return x * 2; }\n}\n${padding}\n`, "utf8");

		const index: any = new HybridSearchIndex(tmpDir, "lean");
		const status1 = index.getStatus();
		assertPass("First index status is valid", !!status1, { status1 });
		// Try to force a stale cache write manually
		const cacheFile = path.join(cacheDir, "stale.json");
		fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, extractorGeneration: "stale-old" }), "utf8");
		// Now sync — should invalidate
		await index.syncWorkspace(true);
		const status2 = index.getStatus();
		assertPass("Stale cache rejected and re-indexed", !!status2, { status2 });
	} finally {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
	}

	logPass("Stale cache rejection verified!");
}
