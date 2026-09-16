import * as fs from "node:fs";
import * as path from "node:path";
import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { getPiHomeDir } from "../../src/config";
import { createTestWorkspace, PY_CODE, assertPass, logPass } from "../_setup";

export async function testVectorCacheSurvivesProfileSwitch(): Promise<void> {
	const ws = createTestWorkspace("vector_profile_cache_");
	const settingsPath = path.join(getPiHomeDir(), "agent", "search_settings.json");
	const hadSettings = fs.existsSync(settingsPath);
	const originalSettings = hadSettings
		? fs.readFileSync(settingsPath, "utf8")
		: undefined;

	try {
		fs.writeFileSync(ws.calculatorPath, PY_CODE, "utf8");
		const leanIndex = new HybridSearchIndex(ws.tempDir, "lean");
		await leanIndex.syncWorkspace(true);

		const chunks = Array.from(
			(leanIndex as any).chunks.values(),
		) as Array<{ id: string }>;
		const vectors = new Map<string, Float32Array>();
		for (const chunk of chunks) {
			vectors.set(chunk.id, new Float32Array(768));
		}
		(leanIndex as any).vectors = vectors;
		(leanIndex as any).saveToDisk();

		const cacheDir = path.join(ws.tempDir, ".pi", "cache", "search");
		const indexPath = path.join(cacheDir, "index.json");
		const initialCache = JSON.parse(fs.readFileSync(indexPath, "utf8"));
		assertPass(
			"768-dim vector cache is persisted independently of the active profile",
			initialCache.vectorCaches?.some((cache: any) => cache.vectorDim === 768) &&
			fs.existsSync(path.join(cacheDir, "vectors-768d.bin")),
			{ initialCache },
		);

		const fullIndex = new HybridSearchIndex(ws.tempDir, "full");
		assertPass(
			"Full profile loads the persisted 768-dim vectors",
			fullIndex.getStatus().vectorCount === chunks.length,
			{ status: fullIndex.getStatus(), chunkCount: chunks.length },
		);

		fullIndex.setProfile("lean");
		await fullIndex.syncWorkspace(false);

		const cacheAfterBm25Save = JSON.parse(fs.readFileSync(indexPath, "utf8"));
		assertPass(
			"BM25 saves preserve the 768-dim cache metadata and file",
			cacheAfterBm25Save.vectorCaches?.some((cache: any) => cache.vectorDim === 768) &&
			fs.existsSync(path.join(cacheDir, "vectors-768d.bin")),
			{ cacheAfterBm25Save },
		);

		const restoredFullIndex = new HybridSearchIndex(ws.tempDir, "full");
		assertPass(
			"Switching to BM25 and back reuses the 768-dim cache",
			restoredFullIndex.getStatus().vectorCount === chunks.length,
			{ status: restoredFullIndex.getStatus(), chunkCount: chunks.length },
		);

		logPass("Vector cache survives BM25 profile switches without re-embedding!");
	} finally {
		if (hadSettings) fs.writeFileSync(settingsPath, originalSettings!, "utf8");
		else fs.rmSync(settingsPath, { force: true });
		ws.cleanup();
	}
}
