import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function run(): Promise<void> {
  console.log("=== Running Production Dependency Policy Tests ===");
  const root = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

  assert.equal(manifest.dependencies["@huggingface/transformers"], "^4.3.0");
  assert.equal(manifest.overrides["adm-zip"], "^0.6.1");
  assert.equal(manifest.overrides["sharp"], "^0.35.4");
  assert.equal(lock.packages["node_modules/@huggingface/transformers"].version, "4.3.0");
  assert.equal(lock.packages["node_modules/onnxruntime-node"].version, "1.30.0");
  assert.equal(lock.packages["node_modules/adm-zip"].version, "0.6.1");
  assert.equal(lock.packages["node_modules/sharp"].version, "0.35.4");
  assert.equal(lock.packages[""].dependencies["@huggingface/transformers"], "^4.3.0");

  console.log("✓ Patched Transformers, ONNX Runtime, adm-zip, and sharp minimums are locked!");
}

if (require.main === module) {
  void run();
}
