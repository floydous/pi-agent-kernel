import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatDefinitions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatReferences,
} from "../../src/lsp/lsp_formatter";
import {
  MAX_LSP_DOCUMENT_BYTES,
  MAX_LSP_DIAGNOSTICS,
  MAX_LSP_STDERR_BYTES,
  StdioLspClient,
} from "../../src/lsp/lsp_client";

export async function run(): Promise<void> {
  console.log("=== Running Bounded LSP Output Tests ===");
  const diagnostics = Array.from({ length: 500 }, (_, i) => ({
    range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
    severity: 1,
    message: "x".repeat(5000),
  })) as any[];
  const diagnosticText = formatDiagnostics(diagnostics);
  assert.ok(diagnosticText.length < 500000);
  assert.match(diagnosticText, /Truncated: 200\/500 diagnostics/);

  const locations = Array.from({ length: 500 }, (_, i) => ({
    uri: "file:///tmp/example.ts",
    range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
  })) as any[];
  assert.match(formatDefinitions(locations), /Truncated: 200\/500 definitions/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-output-"));
  try {
    const file = path.join(root, "large.txt");
    fs.writeFileSync(file, "x".repeat(2 * 1024 * 1024), "utf8");
    const uri = pathToFileURL(file).href;
    const referenceText = formatReferences(locations.map((location) => ({ ...location, uri })) as any[], root);
    assert.ok(referenceText.length < 100000);
    assert.doesNotMatch(referenceText, /x{1000}/);

    let deep: any = { name: "root", kind: 12, range: { start: { line: 0, character: 0 } }, children: [] };
    let cursor = deep;
    for (let i = 0; i < 30; i++) {
      cursor.children.push({ name: `child-${i}`, kind: 12, range: { start: { line: i, character: 0 } }, children: [] });
      cursor = cursor.children[0];
    }
    const symbols = formatDocumentSymbols([deep]);
    assert.ok(symbols.length < 30000);
    assert.match(symbols, /Truncated:/);

    assert.match(formatHover({ contents: "h".repeat(100000) } as any), /Hover truncated/);
    assert.ok(MAX_LSP_STDERR_BYTES > 0 && MAX_LSP_DIAGNOSTICS > 0);

    const huge = path.join(root, "huge.ts");
    const fd = fs.openSync(huge, "w");
    fs.ftruncateSync(fd, MAX_LSP_DOCUMENT_BYTES + 1);
    fs.closeSync(fd);
    const client = new StdioLspClient("limits", { command: process.execPath, args: ["-e", ""], cwd: root, languageId: "typescript" });
    await assert.rejects(() => client.openDocument(huge), /exceeds the/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("! Diagnostics, definitions, references, hover, symbols, documents, and stderr are bounded!");
}

if (require.main === module) {
  void run();
}
