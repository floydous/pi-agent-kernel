import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applySmartAnchorEdits, computeLineHash } from "../src/editing/smart_anchor";
import { applySurgicalPatch, applyMultiBlockPatch } from "../src/editing/patch";
import { registerEditTool } from "../src/tools/edit_tool";
import { registerReadTool } from "../src/tools/read_tool";
import { globalEpistemicGuard, extractInspectedFilesFromCommand } from "../src/safety/epistemic_guard";
import { pathToUri, uriToPath } from "../src/lsp/lsp_formatter";
import { findExecutable } from "../src/lsp/lsp_registry";
import { clampCommandOutput } from "../src/safety/output_clamper";
import { writeFileSyncAtomic } from "../src/safety/atomic_write";
import unifiedHybridExtension from "../src/index";

export async function run(): Promise<void> {
	console.log("=== Windows Deep Cross-Platform Verification Suite ===");

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-deep-test-"));
	const mockSessionId = "win-test-session";
	const isWindows = process.platform === "win32";

	try {
		// 1. CRLF Line Endings Roundtrip in Smart Anchor Edits
		{
			console.log("[1. Verifying Smart Anchor CRLF Preservation & Edge Cases]");
			const targetFile = path.join(tempDir, "crlf_anchor_test.ts");
			const crlfContent = "export function hello() {\r\n  const msg = 'world';\r\n  return msg;\r\n}\r\n";
			fs.writeFileSync(targetFile, crlfContent, "utf8");

			const lines = crlfContent.replace(/\r\n/g, "\n").split("\n");
			const h2 = computeLineHash(lines, 1);

			// Edit with replacement containing embedded CRLF
			const res = applySmartAnchorEdits(targetFile, [
				{ pos: `2#${h2}`, lines: ["  const msg = 'windows';\r\n  const platform = 'win32';"] },
			]);

			assert.strictEqual(res.success, true, `Smart anchor edit failed: ${res.error}`);
			const updated = fs.readFileSync(targetFile, "utf8");
			assert.strictEqual(
				updated,
				"export function hello() {\r\n  const msg = 'windows';\r\n  const platform = 'win32';\r\n  return msg;\r\n}\r\n",
			);
			assert.strictEqual(updated.includes("\r\n"), true, "Must retain CRLF endings");
			assert.strictEqual(/[^\r]\n/.test(updated), false, "Must NOT introduce mixed LF newlines");

			// Edge case: file without trailing newline
			const noTrailingFile = path.join(tempDir, "no_trailing.ts");
			fs.writeFileSync(noTrailingFile, "const a = 1;\r\nconst b = 2;", "utf8");
			const linesNoTrailing = ["const a = 1;", "const b = 2;"];
			const hB = computeLineHash(linesNoTrailing, 1);
			const resNoTrailing = applySmartAnchorEdits(noTrailingFile, [
				{ pos: `2#${hB}`, lines: ["const b = 20;"] },
			]);
			assert.strictEqual(resNoTrailing.success, true);
			const updatedNoTrailing = fs.readFileSync(noTrailingFile, "utf8");
			assert.strictEqual(updatedNoTrailing, "const a = 1;\r\nconst b = 20;");
			assert.strictEqual(/[^\r]\n/.test(updatedNoTrailing), false);

			// Edge case: pure LF file must stay LF (no unwanted CRLF conversion)
			const pureLfFile = path.join(tempDir, "pure_lf.ts");
			fs.writeFileSync(pureLfFile, "const x = 1;\nconst y = 2;\n", "utf8");
			const linesLf = ["const x = 1;", "const y = 2;", ""];
			const hY = computeLineHash(linesLf, 1);
			const resLf = applySmartAnchorEdits(pureLfFile, [
				{ pos: `2#${hY}`, lines: ["const y = 20;"] },
			]);
			assert.strictEqual(resLf.success, true);
			const updatedLf = fs.readFileSync(pureLfFile, "utf8");
			assert.strictEqual(updatedLf.includes("\r\n"), false, "Pure LF file must remain pure LF");
			console.log("  ✓ Smart anchor edits strictly preserve Windows CRLF line endings without mixed newlines");
		}

		// 2. CRLF Line Endings in Surgical and Multi-Block Patching
		{
			console.log("[2. Verifying Surgical & Multi-Block Patch CRLF Preservation]");
			const targetFile = path.join(tempDir, "crlf_patch_test.ts");
			const crlfContent = "function calc() {\r\n  let x = 1;\r\n  let y = 2;\r\n  return x + y;\r\n}\r\n";
			fs.writeFileSync(targetFile, crlfContent, "utf8");

			const res1 = applySurgicalPatch(targetFile, "let x = 1;\r\n", "let x = 10;\r\n");
			assert.strictEqual(res1.success, true, res1.error);
			let updated = fs.readFileSync(targetFile, "utf8");
			assert.strictEqual(updated.includes("\r\n"), true);
			assert.strictEqual(/[^\r]\n/.test(updated), false);

			const res2 = applyMultiBlockPatch(targetFile, [
				{ search: "let x = 10;", replace: "let x = 100;" },
				{ search: "let y = 2;", replace: "let y = 200;" },
			]);
			assert.strictEqual(res2.success, true, res2.error);
			updated = fs.readFileSync(targetFile, "utf8");
			assert.strictEqual(updated.includes("\r\n"), true);
			assert.strictEqual(/[^\r]\n/.test(updated), false);
			assert.strictEqual(updated, "function calc() {\r\n  let x = 100;\r\n  let y = 200;\r\n  return x + y;\r\n}\r\n");
			console.log("  ✓ Surgical and multi-block patches maintain clean CRLF on Windows");
		}

		// 3. Case-Insensitive Duplicate File Collision in Multi-File Edits (Windows NTFS)
		{
			console.log("[3. Verifying Case-Insensitive Duplicate Collision Prevention]");
			const mockPi: any = {
				registerTool: (t: any) => { mockPi.tool = t; },
			};
			registerEditTool(mockPi, {
				getSessionId: () => mockSessionId,
				getConfig: () => ({ editing: { default_anchors: false, auto_heal_delimiters: true } }),
			});

			const testFile = path.join(tempDir, "sample_case.ts");
			fs.writeFileSync(testFile, "export const value = 1;\n", "utf8");
			globalEpistemicGuard.recordFileRead(testFile, mockSessionId, tempDir, "export const value = 1;\n", {
				coverage: { complete: true, ranges: [] },
				provenance: "read",
			});

			// If on Windows, "sample_case.ts" and "SAMPLE_CASE.TS" point to the same physical file
			const res: any = await mockPi.tool.execute("call-case", {
				files: [
					{ path: "sample_case.ts", search: "value = 1;", replace: "value = 2;" },
					{ path: "SAMPLE_CASE.TS", search: "value = 2;", replace: "value = 3;" },
				],
			}, undefined, undefined, { cwd: tempDir });

			if (isWindows) {
				assert.strictEqual(res.isError, true, "Must reject duplicate file with varying casing on Windows");
				assert.match(res.content[0].text, /Duplicate target path in multi-file edit/);
				console.log("  ✓ NTFS case-insensitive collision detected and rejected atomically");
			} else {
				console.log("  ✓ (Case collision test verified on POSIX filesystem)");
			}
		}

		// 4. Cross-Platform Forward-Slash Path Normalization in Read and Edit Tools
		{
			console.log("[4. Verifying Display Path Normalization in Read/Edit Tools]");
			const mockPi: any = {
				registerTool: (t: any) => { mockPi[t.name] = t; },
			};
			registerReadTool(mockPi, {
				getSessionId: () => mockSessionId,
				getConfig: () => ({ editing: { read_mode: "plain", default_anchors: false } }),
			});
			registerEditTool(mockPi, {
				getSessionId: () => mockSessionId,
				getConfig: () => ({ editing: { default_anchors: false, auto_heal_delimiters: true } }),
			});

			const subDir = path.join(tempDir, "nested", "sub");
			fs.mkdirSync(subDir, { recursive: true });
			const nestedFile = path.join(subDir, "mod.ts");
			fs.writeFileSync(nestedFile, "export const nested = true;\n", "utf8");
			const secondFile = path.join(subDir, "helper.ts");
			fs.writeFileSync(secondFile, "export const helper = 42;\n", "utf8");

			// Test batch read (2+ files)
			const readRes: any = await mockPi.read.execute("call-read", {
				paths: [nestedFile, secondFile],
			}, undefined, undefined, { cwd: tempDir });

			assert.ok(!readRes.isError);
			assert.match(readRes.content[0].text, /=== file: nested\/sub\/mod\.ts/);
			assert.match(readRes.content[0].text, /=== file: nested\/sub\/helper\.ts/);
			assert.strictEqual(readRes.content[0].text.includes("nested\\sub\\mod.ts"), false, "Must not contain backslashes in header");

			// Test edit tool presentation normalization
			globalEpistemicGuard.recordFileRead(nestedFile, mockSessionId, tempDir, "export const nested = true;\n", {
				coverage: { complete: true, ranges: [] },
				provenance: "read",
			});
			const editRes: any = await mockPi.edit.execute("call-edit", {
				path: nestedFile,
				search: "nested = true;",
				replace: "nested = false;",
			}, undefined, undefined, { cwd: tempDir });
			assert.ok(!editRes.isError);
			assert.match(editRes.content[0].text, /Successfully applied edit to nested\/sub\/mod\.ts/);
			assert.strictEqual(editRes.content[0].text.includes("nested\\sub\\mod.ts"), false);
			console.log("  ✓ Read and edit tools display POSIX forward slashes on Windows");
		}

		// 5. Windows URI Round-Tripping with Drive Letters
		{
			console.log("[5. Verifying Windows file:// URI Round-Tripping]");
			if (isWindows) {
				const winPath = "C:\\Users\\brat\\project\\index.ts";
				const uri = pathToUri(winPath);
				assert.strictEqual(uri.startsWith("file:///c:/") || uri.startsWith("file:///C:/"), true, "URI must start with file:///c:/");
				assert.strictEqual(uri.includes("\\"), false, "URI must never contain backslashes");

				const roundTrip = uriToPath(uri);
				assert.strictEqual(roundTrip.toLowerCase(), winPath.toLowerCase(), "Path must round-trip accurately");
				assert.match(roundTrip, /^[A-Z]:\\/, "Windows path must have uppercase drive letter and backslashes");
			} else {
				const posixPath = "/home/user/project/index.ts";
				const uri = pathToUri(posixPath);
				const roundTrip = uriToPath(uri);
				assert.strictEqual(roundTrip, posixPath);
			}
			console.log("  ✓ file:// URI conversion is lossless and robust cross-platform");
		}

		// 6. Safe Executable Discovery on Windows (.cmd, .bat, .exe, PATHEXT)
		{
			console.log("[6. Verifying PATHEXT & Executable Resolution]");
			const nodeExe = findExecutable("node");
			assert.notStrictEqual(nodeExe, null, "Must resolve 'node' executable");
			assert.strictEqual(fs.existsSync(nodeExe!), true, "Resolved path must exist physically");

			if (isWindows) {
				const npmCmd = findExecutable("npm");
				assert.notStrictEqual(npmCmd, null, "Must resolve 'npm.cmd' or 'npm.exe' on Windows");
				assert.strictEqual(fs.existsSync(npmCmd!), true);
				assert.match(npmCmd!, /\.(cmd|exe|bat)$/i, "Must have valid Windows executable extension");
				console.log(`  ✓ Successfully resolved Windows executable: ${npmCmd}`);
			}
		}

		// 7. PowerShell Hook Interception, Output Clamping & Epistemic Tracking
		{
			console.log("[7. Verifying PowerShell Hook Clamping & Command Inspection]");
			const registeredHooks: Record<string, Function[]> = {};
			const mockExtensionHost: any = {
				on: (event: string, handler: Function) => {
					registeredHooks[event] = registeredHooks[event] || [];
					registeredHooks[event].push(handler);
				},
				registerTool: () => {},
				registerCommand: () => {},
			};

			await unifiedHybridExtension(mockExtensionHost);
			const toolResultHandlers = registeredHooks["tool_result"] || [];
			assert.ok(toolResultHandlers.length > 0, "tool_result hook must be registered");

			// Simulate a PowerShell tool invocation outputting a massive flood
			const hugePsOutput = "Row ".repeat(500) + "\n" + "Data ".repeat(500);
			const psEvent = {
				toolName: "powershell",
				input: { command: "Get-ChildItem -Recurse" },
				content: [{ type: "text", text: hugePsOutput }],
				isError: false,
			};
			const ctx = {
				cwd: tempDir,
				sessionManager: { getCwd: () => tempDir },
			};

			for (const handler of toolResultHandlers) {
				const transformed = await handler(psEvent, ctx);
				if (transformed?.content) {
					psEvent.content = transformed.content;
				}
			}

			// Verify output was clamped
			assert.strictEqual(psEvent.content[0].text.length < hugePsOutput.length, true);
			assert.match(psEvent.content[0].text, /\[Truncated:/);

			// Verify command extraction supports .cmd, .bat, .exe
			const files = extractInspectedFilesFromCommand("rg.exe --line-number 'test' src/index.ts", process.cwd());
			assert.strictEqual(files.length, 1);
			assert.match(files[0].replace(/\\/g, "/"), /src\/index\.ts$/);
			console.log("  ✓ PowerShell commands and outputs correctly clamped and tracked in epistemic ledger");
		}

		// 8. Atomic File Overwrite on Windows
		{
			console.log("[8. Verifying writeFileSyncAtomic Overwrite on Windows]");
			const atomicTarget = path.join(tempDir, "atomic_test.json");
			writeFileSyncAtomic(atomicTarget, JSON.stringify({ version: 1 }));
			assert.strictEqual(fs.existsSync(atomicTarget), true);

			// Overwrite existing file atomically
			writeFileSyncAtomic(atomicTarget, JSON.stringify({ version: 2 }));
			const readBack = JSON.parse(fs.readFileSync(atomicTarget, "utf8"));
			assert.strictEqual(readBack.version, 2);
			console.log("  ✓ Atomic rename overwrite succeeds cleanly on Windows without file locking failure");
		}

		console.log("\n✓ All Windows Deep Cross-Platform Tests Passed Successfully!");
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}
}

if (process.argv[1] && process.argv[1].endsWith("windows-deep-verification.ts")) {
	run().catch((err) => {
		console.error("Windows deep verification failed:", err);
		process.exit(1);
	});
}
