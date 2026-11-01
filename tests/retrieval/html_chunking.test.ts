import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { chunkHtmlFile, DEFAULT_HTML_CHUNKER_OPTIONS } from "../../src/retrieval/html_chunker";

export async function run(): Promise<void> {
	console.log("=== Running HTML Semantic Chunking & Retrieval Test Suite ===");
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-html-chunk-pidir-"));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-html-chunk-ws-"));
	process.env.PI_DIR = piDir;

	try {
		// 1. Grammar Loading
		console.log("1. TreeSitterEngine loads tree-sitter-html.wasm for .html and .htm...");
		const engine = TreeSitterEngine.getInstance();
		await engine.loadLanguages([".html", ".htm"]);
		assert.ok(engine.getParser(".html"), "HTML parser must be initialized for .html");
		assert.ok(engine.getParser(".htm"), "HTML parser must be initialized for .htm");

		// 2. Leaf Control Rollup & Clean Partitioning
		console.log("2. Leaf controls roll into semantic groups; exact source slices are preserved...");
		const pageHtml = `<!doctype html>
<html lang="en">
<head><title>Test Page</title></head>
<body>
  <header class="header">
    <div class="brand">App Brand</div>
    <button id="btn-theme" class="btn">Toggle Theme</button>
  </header>
  <main class="content">
    <div class="toolbar-box">
      <input type="text" id="query-input" placeholder="Search items...">
      <button id="btn-search">Search</button>
    </div>
    <section id="main-panel" class="panel">
      <h2>Items List</h2>
      <p>Item 1</p>
      <p>Item 2</p>
      <p>Item 3</p>
      <p>Item 4</p>
    </section>
  </main>
  <footer>
    <button id="btn-footer-help">Help</button>
  </footer>
</body>
</html>`;
		const testHtmlPath = path.join(workspace, "index.html");
		fs.writeFileSync(testHtmlPath, pageHtml, "utf8");

		const chunks = chunkHtmlFile(workspace, testHtmlPath, pageHtml);
		assert.ok(chunks.length >= 3, `Must create >=3 chunks, got ${chunks.length}`);

		for (const chunk of chunks) {
			assert.equal(chunk.kind, "html");
			assert.ok(chunk.startLine >= 1);
			assert.ok(chunk.endLine >= chunk.startLine);
			const expectedSlice = pageHtml.split(/\r?\n/).slice(chunk.startLine - 1, chunk.endLine).join("\n");
			assert.equal(chunk.content, expectedSlice, `Chunk ${chunk.id} content must match exact source slice`);
		}

		// Ensure buttons are rolled up into their containing header/toolbar/footer
		const headerChunk = chunks.find((c) => c.symbolName.includes("header"));
		assert.ok(headerChunk, "Header chunk must be emitted");
		assert.ok(headerChunk.signature.includes("btn-theme"), "Header signature must summarize rolled-up child button");

		// 3. Inline Raw Style / Script Hard Boundaries
		console.log("3. Inline <style> raw content suppresses enclosing parent and never contaminates UI chunks...");
		const rawBoundaryHtml = `<!doctype html>
<html>
<body>
  <main id="settings-page">
    <section id="settings-panel">
      <div id="controls-before" class="control-group">
        <label for="theme">Theme</label>
        <select id="theme">
          <option>Dark</option>
        </select>
      </div>
      <style>
        #settings-panel { color: white; display: block; }
        .control-group { margin: 10px; }
      </style>
      <div id="controls-after" class="control-group">
        <label for="density">Density</label>
        <select id="density">
          <option>Comfortable</option>
        </select>
      </div>
    </section>
  </main>
</body>
</html>`;
		const rawHtmlPath = path.join(workspace, "settings.html");
		fs.writeFileSync(rawHtmlPath, rawBoundaryHtml, "utf8");

		const rawChunks = chunkHtmlFile(workspace, rawHtmlPath, rawBoundaryHtml);
		assert.equal(rawChunks.some((c) => c.content.includes("#settings-panel { color: white;")), false, "No chunk may contain raw style block");
		assert.ok(rawChunks.some((c) => c.symbolName.includes("controls-before")), "Control group before style must survive");
		assert.ok(rawChunks.some((c) => c.symbolName.includes("controls-after")), "Control group after style must survive");

		// 4. Oversized Subtree Fallback Partitioning
		console.log("4. Oversized elements without eligible child groups partition cleanly into <=70-line chunks...");
		const rows = Array.from({ length: 60 }, (_, i) => `    <tr>\n      <td>Row ${i + 1}</td>\n    </tr>`).join("\n");
		const tableHtml = `<!doctype html>\n<html>\n<body>\n  <table id="huge-table">\n${rows}\n  </table>\n</body>\n</html>`;
		const tablePath = path.join(workspace, "table.html");
		fs.writeFileSync(tablePath, tableHtml, "utf8");

		const tableChunks = chunkHtmlFile(workspace, tablePath, tableHtml);
		assert.ok(tableChunks.length >= 2, `Oversized table must produce >= 2 chunks, got ${tableChunks.length}`);
		for (const tc of tableChunks) {
			const span = tc.endLine - tc.startLine + 1;
			assert.ok(span <= DEFAULT_HTML_CHUNKER_OPTIONS.maximumLines, `Fallback chunk span must be <= maximumLines (${DEFAULT_HTML_CHUNKER_OPTIONS.maximumLines}), got ${span}`);
		}

		// 5. Index Integration, Search, & Persistence
		console.log("5. HybridSearchIndex indexes HTML, retrieves via BM25, and persists/reloads cleanly...");
		const index = new HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await index.syncWorkspace(true);

		const searchHits = await index.search("Toggle Theme button", { limit: 3 });
		assert.ok(searchHits.length > 0, "Code search must return hits for HTML UI queries");
		assert.equal(searchHits[0].chunk.filePath, "index.html");
		assert.ok(searchHits[0].chunk.content.includes("btn-theme"));

		await index.flushPendingSave(true);

		// Reload index from disk
		const reloaded = new HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		assert.equal(reloaded.loadFromDisk(), true, "Index with HTML chunks must load cleanly from disk");
		const reloadedHits = await reloaded.search("Search items", { limit: 3 });
		assert.ok(reloadedHits.length > 0, "Reloaded index must return search hits");
		assert.equal(reloadedHits[0].chunk.filePath, "index.html");

		console.log("✓ All HTML Semantic Chunking & Retrieval Tests Passed!");
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	void run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
