import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
  getSearchConfig,
} from "../../src/retrieval/search_config";
import { LocalEmbedder } from "../../src/retrieval/search_embedder";

const REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab";

export async function run(): Promise<void> {
  console.log("=== Running Immutable Embedding Model Revision Tests ===");
  assert.equal(EMBEDDING_MODEL_ID, "nomic-ai/nomic-embed-text-v1.5");
  assert.equal(EMBEDDING_MODEL_REVISION, REVISION);
  for (const profile of ["off", "lean", "hybrid", "full"] as const) {
    const config = getSearchConfig(profile);
    assert.equal(config.modelId, EMBEDDING_MODEL_ID);
    assert.equal(config.modelRevision, REVISION);
  }

  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "retrieval", "search_embedder.ts"),
    "utf8",
  );
  assert.match(source, /revision:\s*this\.config\.modelRevision/);
  assert.match(source, /snapshots["',)]*,?\s*this\.config\.modelRevision|path\.join\(dir, "snapshots", this\.config\.modelRevision\)/);

  const originalHome = process.env.USERPROFILE;
  const originalUnixHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-revision-home-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const snapshot = path.join(
      home,
      ".cache",
      "huggingface",
      "hub",
      "models--nomic-ai--nomic-embed-text-v1.5",
      "snapshots",
      REVISION,
    );
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, "config.json"), "{}\n");
    assert.equal(new LocalEmbedder(getSearchConfig("full")).isCachedOnDisk(), true);

    const wrongRevision = {
      ...getSearchConfig("full"),
      modelRevision: "0".repeat(40),
    };
    assert.equal(
      new LocalEmbedder(wrongRevision).isCachedOnDisk(),
      false,
      "a different model revision must not satisfy the pinned cache check",
    );
  } finally {
    if (originalHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalHome;
    if (originalUnixHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalUnixHome;
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log("✓ Embedding model ID/revision are immutable and only the exact revision is cache-valid!");
}

if (require.main === module) {
  void run();
}
