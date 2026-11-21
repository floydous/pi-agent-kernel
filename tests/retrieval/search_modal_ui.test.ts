import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SearchControlModal } from "../../src/retrieval/search_modal";
import { HybridSearchIndex } from "../../src/retrieval/search_index";
import { loadKernelConfig } from "../../src/config/kernel_config";
import { logPass } from "../_setup";

export async function run(): Promise<void> {
	console.log("=== Running Search Control Modal UI & Navigation Test Suite ===");

	const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "modal-ui-isolated-"));
	const previousPiDir = process.env.PI_DIR;
	process.env.PI_DIR = path.join(isolatedCwd, ".pi-home");

	try {
	const excludedSet = new Set<string>();

	const mockIndex: any = {
		profile: "lean",
		getProfile() {
			return this.profile;
		},
		setProfile(p: string) {
			this.profile = p;
		},
		getEffectiveProfile() {
			return this.profile;
		},
		getStatus() {
			return {
				engineState: "ready",
				pipelineDesc: "Fast AST BM25",
				profile: this.profile,
				effectiveProfile: this.profile,
				hardwareInfo: "8 CPUs",
				fileCount: 42,
				chunkCount: 318,
				vectorCount: 0,
				modelStatus: "Active (BM25 only)",
				rssMemoryMB: 142,
				isModelCached: false,
			};
		},
		getExcludedPaths() {
			return new Set(excludedSet);
		},
		setExcludedPaths(paths: Iterable<string>) {
			excludedSet.clear();
			for (const p of paths) excludedSet.add(p);
		},
		getIndexableFiles() {
			return [
				"src/retrieval/search_index.ts",
				"src/retrieval/search_modal.ts",
				"src/tools/edit_tool.ts",
				"tests/setup.ts",
				"package.json",
			];
		},
		getChunkCountForFile(rel: string) {
			if (rel.includes("search_index.ts")) return 18;
			if (rel.includes("search_modal.ts")) return 5;
			if (rel.includes("edit_tool.ts")) return 12;
			if (rel.includes("setup.ts")) return 3;
			return 1;
		},
	};

	const mockTheme: any = {
		fg(name: string, str: string) {
			return `[${name}]${str}[/${name}]`;
		},
		bold(str: string) {
			return `<b>${str}</b>`;
		},
		dim(str: string) {
			return `<dim>${str}</dim>`;
		},
	};

	let renderRequested = 0;
	const mockTui: any = {
		requestRender() {
			renderRequested++;
		},
	};

	let modalResult: any = null;
	const done = (res: any) => {
		modalResult = res;
	};

	// 1. Instantiation & Tab 1 Rendering (Retrieval Engine)
	console.log("1. Testing initial cursor position and theme rendering on Tab 1 (Retrieval Engine)...");
	const modal = new SearchControlModal(mockTui, mockIndex, mockTheme, done, { cwd: isolatedCwd });
	let lines = modal.render(80);

	assert.ok(lines.length > 10, "Modal must render multiple lines");
	assert.ok(lines.some((l) => l.includes("Kernel Settings")), "Must include Kernel Settings Tab Header");
	assert.ok(lines.some((l) => l.includes("Retrieval Engine")), "Must include Retrieval Engine Tab Header");
	assert.ok(lines.some((l) => l.includes("File Index Scope")), "Must include File Index Scope Tab Header");
	assert.ok(lines.some((l) => l.includes("Engine Profiles")), "Must include Engine Profiles section");
	assert.ok(lines.some((l) => l.includes("◉") && l.includes("Lean Mode")), "Current profile Lean must have radio ◉");

	// Ensure no hardcoded full-viewport stippling or 256-color card background
	assert.ok(!lines.some((l) => l.includes("░")), "Must not include ASCII stippling");
	assert.ok(!lines.some((l) => l.includes("\x1b[48;5;234m")), "Must not include hardcoded 256-color card background");

	// 2. Navigation & Selection on Tab 0
	console.log("2. Testing keyboard navigation and selection on Tab 0...");
	await modal.handleInput("\x1b[B"); // Arrow Down
	assert.equal(renderRequested, 1, "Moving down via arrow key must request render");
	await modal.handleInput("j"); // 'j' Down
	assert.equal(renderRequested, 2, "Moving down via 'j' must request render");

	// 3. Tab Switching to Tab 1 (Scope & File Indexing)
	console.log("3. Testing tab switching via Tab key...");
	await modal.handleInput("\t"); // Tab key
	lines = modal.render(80);

	assert.ok(lines.some((l) => l.includes("Workspace Index Scope")), "Tab 2 must display Workspace Index Scope header");
	assert.ok(lines.some((l) => l.includes("src/") && l.includes("■")), "Must display src/ directory node with ■");
	assert.ok(lines.some((l) => l.includes("tests/") && l.includes("■")), "Must display tests/ directory node with ■");
	assert.ok(lines.some((l) => l.includes("package.json")), "Must display root files");
	assert.ok(lines.some((l) => l.includes("Preview Folder:") || l.includes("Preview:")), "Must display chunk preview card at bottom");

	// 4. Scope Tree Navigation & Folder Expansion
	console.log("4. Testing folder expansion and collapse in Scope Tree...");
	// Expand 'src/' or navigate into it
	await modal.handleInput("\x1b[B"); // Arrow down to next node
	lines = modal.render(80);

	// Toggle folder expansion with Right Arrow
	await modal.handleInput("\x1b[C"); // Expand
	lines = modal.render(80);

	// 5. Preview of File Chunks
	console.log("5. Testing file chunk count preview...");
	// Move down to a file node
	await modal.handleInput("\x1b[B");
	await modal.handleInput("\x1b[B");
	lines = modal.render(80);

	const previewLine = lines.find((l) => l.includes("Preview:"));
	assert.ok(previewLine, "Must display live file preview card");
	assert.ok(lines.some((l) => l.includes("Will produce") && l.includes("chunk(s)")), "Preview must state exact chunk count for file");

	// 6. Selection Toggling (Space)
	console.log("6. Testing selection toggling via Space key...");
	await modal.handleInput(" "); // Toggle exclusion on current file
	lines = modal.render(80);
	assert.ok(lines.some((l) => l.includes("EXCLUDED") || l.includes("□")), "Target file must now be marked EXCLUDED with □");

	// 7. Finish Modal & Verify Excluded Paths Propagation
	console.log("7. Testing modal dismissal with scope changes...");
	await modal.handleInput("\x1b"); // Escape
	assert.ok(modalResult, "Dismissing must call done()");
	assert.equal(modalResult.action, "close");
	assert.equal(modalResult.excludedPathsChanged, true, "Must flag excludedPathsChanged as true");
	assert.ok(excludedSet.size > 0, "Excluded paths must be saved back to index");

	// 8. Test No-Op Dismissal (Zero changes must NOT reindex)
	console.log("8. Verifying zero-change dismissal does NOT reindex...");
	modalResult = null;
	const cleanModal = new SearchControlModal(mockTui, mockIndex, mockTheme, done, { cwd: isolatedCwd });
	await cleanModal.handleInput("\x1b"); // Escape immediately without changes
	assert.ok(modalResult, "Dismissing must call done()");
	assert.equal(modalResult.action, "close");
	assert.equal(modalResult.reindexed, false, "reindexed must be false when no changes were made");
	assert.equal(modalResult.excludedPathsChanged, false, "excludedPathsChanged must be false when no changes were made");

	// 9. Nested Ancestor Exclusion Dismantling
	console.log("9. Testing ancestor exclusion dismantling when subfolder is re-included...");
	excludedSet.clear();
	excludedSet.add("src"); // Entire src folder excluded
	const nestedModal = new SearchControlModal(mockTui, mockIndex, mockTheme, done, { cwd: isolatedCwd });
	await nestedModal.handleInput("\t"); // Switch to Tab 2

	// Position 0 is 'src/'. Expand it
	await nestedModal.handleInput("\x1b[C"); // Expand 'src/'
	// Position 1 is 'src/retrieval/'. Toggle space to include it!
	await nestedModal.handleInput("\x1b[B"); // Move down to 'src/retrieval/'
	await nestedModal.handleInput(" "); // Space: unexclude 'src/retrieval/'

	// Finish and inspect resulting excludedSet
	await nestedModal.handleInput("\x1b");
	assert.ok(!excludedSet.has("src"), "'src' must no longer be in excludedSet");
	assert.ok(!excludedSet.has("src/retrieval"), "'src/retrieval' must not be in excludedSet");
	assert.ok(excludedSet.has("src/tools"), "Sibling folder 'src/tools' must be preserved as clean directory exclusion");

	// 10. Empty Workspace Scope Tab
	console.log("10. Testing empty workspace scope tab resilience...");
	const emptyIndex: any = {
		...mockIndex,
		getIndexableFiles: () => [],
		getExcludedPaths: () => new Set(),
	};
	const emptyModal = new SearchControlModal(mockTui, emptyIndex, mockTheme, done, { cwd: isolatedCwd });
	await emptyModal.handleInput("\t"); // Tab to Scope tab
	const emptyLines = emptyModal.render(80);
	assert.ok(emptyLines.some((l) => l.includes("No indexable source code files")), "Must display empty notice");
	await emptyModal.handleInput("\x1b[D"); // Left arrow must switch back to Tab 0 without error
	const backLines = emptyModal.render(80);
	assert.ok(backLines.some((l) => l.includes("Retrieval Engine")), "Left arrow must switch back to Tab 1");

	// 11. Scope Exclusion Persistence to Disk (.pi/config.toml)
	console.log("11. Testing end-to-end scope exclusion persistence to .pi/config.toml...");
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-persist-test-"));
	try {
		fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src", "main.ts"), "export const main = 1;");
		fs.writeFileSync(path.join(tmpDir, "src", "test.ts"), "export const test = 2;");

		const liveIndex = new HybridSearchIndex(tmpDir, "lean", { projectTrusted: true });
		await liveIndex.syncWorkspace(true);

		let persistedResult: any = null;
		const persistModal = new SearchControlModal(
			mockTui,
			liveIndex,
			mockTheme,
			(res) => { persistedResult = res; },
			{
				initialTab: 2,
				cwd: tmpDir,
				deps: {
					getConfig: (c) => loadKernelConfig(c, { projectTrusted: true }),
					invalidateConfig: () => {},
				},
			},
		);

		// Expand src and toggle exclusion on src/test.ts
		const scopeNodes = (persistModal as any).getVisibleTreeNodes();
		const targetNode = scopeNodes.find((n: any) => n.relPath === "src/test.ts");
		assert.ok(targetNode, "Must locate src/test.ts in scope tree");
		(persistModal as any).toggleNodeSelection(targetNode);

		// Dismiss modal
		await persistModal.handleInput("\x1b");
		assert.ok(persistedResult?.excludedPathsChanged, "Must report excludedPathsChanged: true");

		// Verify .pi/config.toml was created and contains excluded_paths
		const cfgPath = path.join(tmpDir, ".pi", "config.toml");
		assert.ok(fs.existsSync(cfgPath), ".pi/config.toml must be written to disk");
		const cfgContent = fs.readFileSync(cfgPath, "utf8");
		assert.ok(cfgContent.includes("excluded_paths"), "config.toml must include excluded_paths");
		assert.ok(cfgContent.includes("src/test.ts"), "config.toml must include 'src/test.ts'");

		// Verify reload into a fresh index restores the excluded paths
		const restoredIndex = new HybridSearchIndex(tmpDir, "lean", { projectTrusted: true });
		assert.ok(restoredIndex.isPathExcluded("src/test.ts"), "Restored index must maintain isPathExcluded('src/test.ts')");
		assert.ok(!restoredIndex.isPathExcluded("src/main.ts"), "Restored index must not exclude 'src/main.ts'");

		// 12. updateFile() rejects excluded files
		console.log("12. Testing updateFile() rejection for excluded files...");
		const excludedFilePath = path.join(tmpDir, "src", "test.ts");
		await restoredIndex.updateFile(excludedFilePath);
		const testChunks = (restoredIndex as any).chunks.idsForFile("src/test.ts") || [];
		assert.equal(testChunks.length, 0, "updateFile() must not add chunks for excluded path");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(isolatedCwd, { recursive: true, force: true });
	}

	logPass("All Search Control Modal UI & Navigation Tests Passed Successfully!");
}
