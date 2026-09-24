import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_ACTION_REFS = new Map([
  ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
  ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"],
]);

export async function run(): Promise<void> {
  console.log("=== Running Immutable GitHub Action Pin Tests ===");
  const workflowDir = path.join(process.cwd(), ".github", "workflows");
  const workflowFiles = fs
    .readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name));

  assert.ok(workflowFiles.length > 0, "at least one workflow must exist");
  let checkedUses = 0;
  for (const file of workflowFiles) {
    const text = fs.readFileSync(path.join(workflowDir, file), "utf8");
    const uses = [...text.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$/gm)];
    for (const match of uses) {
      const reference = match[1]!;
      if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
      const separator = reference.lastIndexOf("@");
      assert.ok(separator > 0, `${file} has an invalid action reference: ${reference}`);
      const action = reference.slice(0, separator);
      const revision = reference.slice(separator + 1);
      assert.match(
        revision,
        /^[0-9a-f]{40}$/i,
        `${file} must pin ${action} to a full commit SHA, got ${revision}`,
      );
      assert.equal(
        revision,
        EXPECTED_ACTION_REFS.get(action),
        `${file} has an unreviewed revision for ${action}`,
      );
      assert.ok(match[2]?.trim(), `${file} must document the human-readable action tag`);
      checkedUses++;
    }
  }

  assert.ok(checkedUses >= 8, "expected CI and release workflows to contain pinned action uses");
  assert.doesNotMatch(
    fs.readFileSync(path.join(workflowDir, "ci.yml"), "utf8"),
    /uses:\s*[^\s#]+@v\d+/,
    "CI workflow contains a mutable action tag",
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(workflowDir, "release.yml"), "utf8"),
    /uses:\s*[^\s#]+@v\d+/,
    "release workflow contains a mutable action tag",
  );

  console.log(`✓ ${checkedUses} GitHub Action uses are immutable and documented!`);
}

if (require.main === module) {
  void run();
}
