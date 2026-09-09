import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateCodebaseMetrics, computeRepoMap, isTestPath } from "../../src/retrieval/repomap";
import { loadKernelConfig } from "../../src/config";
import { createTestWorkspace, assertPass, logPass } from "../_setup";
import { registerRepoMapTool } from "../../src/tools/repo_map_tool";
import { registerAstSearchTool } from "../../src/tools/ast_search_tool";
import { registerCodeSearchTool } from "../../src/tools/code_search_tool";
import { registerReadTool } from "../../src/tools/read_tool";
import { registerEditTool } from "../../src/tools/edit_tool";
import { registerLspTool } from "../../src/tools/lsp_tool";
import { registerRecallTool } from "../../src/dedup/recall_tool";

export async function testAdaptiveRepoMapThreshold(): Promise<void> {
	const ws = createTestWorkspace("repomap_adaptive_");
	try {
		const cfg = loadKernelConfig(ws.tempDir);
		assertPass("Default repo_map_min_files is 10", cfg.retrieval.repo_map_min_files === 10);
		assertPass("Default repo_map_min_bytes is 50KB", cfg.retrieval.repo_map_min_bytes === 50 * 1024);

		// 1. Test path detection helper
		assertPass("isTestPath identifies /test/ directory", isTestPath("test/base.test.ts"));
		assertPass("isTestPath identifies .spec. file", isTestPath("src/router.spec.ts"));
		assertPass("isTestPath does not match regular source file", !isTestPath("src/router.ts"));

		// 2. Micro-modular repository (2 small files added to workspace): isLight === true
		fs.writeFileSync(path.join(ws.tempDir, "a.ts"), "export const a = 1;");
		fs.writeFileSync(path.join(ws.tempDir, "b.ts"), "export const b = 2;");
		const m1 = evaluateCodebaseMetrics(ws.tempDir, cfg.retrieval.repo_map_min_files, cfg.retrieval.repo_map_min_bytes);
		assertPass("Small workspace classified as light", m1.isLight && m1.implFiles <= 10);

		// 3. Test-heavy repository (e.g. 5 impl files + 25 test files): isLight === true
		// (Guarantees test files do not cause false-positive large classification)
		fs.mkdirSync(path.join(ws.tempDir, "tests"), { recursive: true });
		for (let i = 0; i < 25; i++) {
			fs.writeFileSync(path.join(ws.tempDir, "tests", `test_${i}.test.ts`), `// test ${i}`);
		}
		for (let i = 0; i < 3; i++) {
			fs.writeFileSync(path.join(ws.tempDir, `impl_${i}.ts`), `export const x_${i} = ${i};`);
		}
		const mTestHeavy = evaluateCodebaseMetrics(ws.tempDir, cfg.retrieval.repo_map_min_files, cfg.retrieval.repo_map_min_bytes);
		assertPass("Test files separated from impl files", mTestHeavy.testFiles === 25 && mTestHeavy.implFiles <= 10);
		assertPass("Test-heavy small repo remains light", mTestHeavy.isLight);

		// 4. Monolith repository (2 impl files, but 80 KB total): isLight === false
		const largeBuf = "export function process() { return 1; }\n".repeat(2000); // ~80 KB
		fs.writeFileSync(path.join(ws.tempDir, "monolith.ts"), largeBuf);
		const mMonolith = evaluateCodebaseMetrics(ws.tempDir, cfg.retrieval.repo_map_min_files, cfg.retrieval.repo_map_min_bytes);
		assertPass("Large single-file monolith classified as not light (triggers map)", !mMonolith.isLight, {
			implFiles: mMonolith.implFiles,
			implBytes: mMonolith.implBytes,
		});

		// 5. Multi-file medium repo (15 impl files @ 5KB = 75 KB): isLight === false (No blind spot)
		const ws2 = createTestWorkspace("repomap_multimed_");
		try {
			for (let i = 0; i < 15; i++) {
				fs.writeFileSync(path.join(ws2.tempDir, `mod_${i}.ts`), "export const v = 1;\n".repeat(250));
			}
			const mMulti = evaluateCodebaseMetrics(ws2.tempDir, cfg.retrieval.repo_map_min_files, cfg.retrieval.repo_map_min_bytes);
			assertPass("15 files @ 75KB classified as not light (no AND-gate blind spot)", !mMulti.isLight && mMulti.implFiles >= 15);

			const map = computeRepoMap(ws2.tempDir, cfg.retrieval.repo_map_budget);
			assertPass("Repo map computed for multi-file repo", map.includes("Repository Map"));
		} finally {
			ws2.cleanup();
		}

		// 6. Verify all compact tool schemas
		const tools: any[] = [];
		const mockPi: any = { registerTool(t: any) { tools.push(t); } };

		registerRepoMapTool(mockPi);
		registerAstSearchTool(mockPi, { getSessionId: () => "test", getConfig: () => cfg });
		registerCodeSearchTool(mockPi, { getSessionId: () => "test", getSearchIndex: () => ({} as any), getConfig: () => cfg });
		registerReadTool(mockPi, { getSessionId: () => "test", getConfig: () => cfg });
		registerEditTool(mockPi, { getSessionId: () => "test", getConfig: () => cfg, invalidateSearchFile: () => {} });
		registerLspTool(mockPi, { getSessionId: () => "test", getConfig: () => cfg });
		registerRecallTool(mockPi, { getSessionId: () => "test", getDedupStore: () => ({} as any) });

		assertPass("All 7 tools registered", tools.length === 7);

		for (const t of tools) {
			assertPass(`Tool ${t.name} has description and promptSnippet`, !!t.description && !!t.promptSnippet);
			assertPass(`Tool ${t.name} has parameters object`, !!t.parameters && t.parameters.type === "object");
			const jsonLen = JSON.stringify(t).length;
			assertPass(`Tool ${t.name} schema is compact (< 1200 chars)`, jsonLen < 1200, {
				name: t.name,
				chars: jsonLen,
			});
		}

		logPass("Adaptive repo map threshold, test separation, and compact tool schemas verified!");

		// 7. Test /profile slash command integration
		const registeredCommands: Record<string, any> = {};
		const eventHandlers: Record<string, Function[]> = {};
		const mockPiApp: any = {
			registerTool: () => {},
			registerCommand: (name: string, def: any) => { registeredCommands[name] = def; },
			on: (event: string, fn: any) => {
				if (!eventHandlers[event]) eventHandlers[event] = [];
				eventHandlers[event].push(fn);
			},
		};

		// Dynamically import unified extension to register commands
		const kernelExt = (await import("../../src/index")).default;
		await kernelExt(mockPiApp);

		assertPass("/profile command registered", !!registeredCommands["profile"]);
		const profileCmd = registeredCommands["profile"];

		// Test argument completions
		const completions = profileCmd.getArgumentCompletions("");
		assertPass("Profile completions include auto, light, heavy, status",
			completions && completions.some((c: any) => c.value === "auto") &&
			completions.some((c: any) => c.value === "light") &&
			completions.some((c: any) => c.value === "heavy") &&
			completions.some((c: any) => c.value === "status")
		);

		// Test handlers
		let lastNotification = "";
		const mockCtx = {
			cwd: ws.tempDir,
			sessionManager: { getSessionId: () => "test-sess-1" },
			ui: { notify: (msg: string) => { lastNotification = msg; } },
		};

		await profileCmd.handler("light", mockCtx);
		assertPass("Setting profile to light notifies session", lastNotification.includes("'light'"));

		await profileCmd.handler("smart", mockCtx);
		assertPass("Setting profile to smart sets to auto", lastNotification.includes("'auto'"));

		await profileCmd.handler("status", mockCtx);
		assertPass("Status command shows profile and metrics", lastNotification.includes("Profile:") && lastNotification.includes("Metrics:"));

		logPass("/profile command and completions fully verified!");
	} finally {
		ws.cleanup();
	}
}
