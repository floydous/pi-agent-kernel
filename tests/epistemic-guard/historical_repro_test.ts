import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EpistemicGuard } from "../../src/safety/epistemic_guard";
import { preflightSurgicalPatchBlock } from "../../src/editing/patch";
import { assertPass, logPass } from "../_setup";

export function testHistoricalSessionReproductions(): void {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "epistemic-hist-repro-"));

	function createSourceFile(relPath: string, lineCount = 800): string {
		const absPath = path.join(tmpDir, relPath);
		fs.mkdirSync(path.dirname(absPath), { recursive: true });
		const lines: string[] = [];
		for (let i = 1; i <= lineCount; i++) {
			if (i === 200) {
				lines.push("pub fn handle_send_error() {");
			} else if (i === 201) {
				lines.push("    let error_msg = send_error.to_string();");
			} else if (i === 202) {
				lines.push("    let host = &request.client_host;");
			} else if (i === 203) {
				lines.push("}");
			} else if (i === 344) {
				lines.push("						if (localHover) {");
			} else if (i === 345) {
				lines.push('							return { content: [{ type: "text", text: localHover }] };');
			} else if (i === 346) {
				lines.push("						}");
			} else if (i === 671) {
				lines.push("						if (localHover) {");
			} else if (i === 672) {
				lines.push('							return { content: [{ type: "text", text: localHover }] };');
			} else if (i === 673) {
				lines.push("						}");
			} else if (i === 735) {
				lines.push('            client_host: "test".to_string(),');
			} else if (i === 736) {
				lines.push("        }");
			} else {
				lines.push(`// Line ${i}: generic statement or comment in file`);
			}
		}
		fs.writeFileSync(absPath, lines.join("\n"), "utf8");
		return absPath;
	}

	try {
		const upstreamRs = createSourceFile("src/upstream.rs", 800);
		const lspToolTs = createSourceFile("src/tools/lsp_tool.ts", 700);

		const guard = new EpistemicGuard();
		const session = "historical-session-repro";

		// -------------------------------------------------------------------------
		// HISTORICAL ROOT CAUSE 1: THE FALSE DRIFT BUG (Session 01a06619)
		// Agent edits Turn 77, runs `cargo test`, then edits Turn 81 -> NO FALSE DRIFT!
		// -------------------------------------------------------------------------
		// 1. Agent reads region [200, 203]
		guard.recordFileRead(upstreamRs, session, tmpDir, undefined, {
			coverage: { complete: false, ranges: [{ startLine: 200, endLine: 203 }] },
			provenance: "read",
		});

		// 2. First edit on lines 201-202
		const edit1 = `    let error_msg = send_error.to_string();
    let host = &request.client_host;`;
		const pre1 = preflightSurgicalPatchBlock(upstreamRs, edit1);
		assertPass("Preflight locates edit1", pre1.success && pre1.targetRange !== undefined, { pre1 });

		const res1 = guard.checkReadPrecondition(
			upstreamRs,
			"edit",
			session,
			tmpDir,
			true,
			pre1.targetRange ? [pre1.targetRange] : [],
			[edit1],
		);
		assertPass("First edit is authorized under Tier 1", res1.allowed && res1.tier === 1, { res1 });

		// Apply first edit and record mutation
		const patchedContent = fs.readFileSync(upstreamRs, "utf8").replace(
			"    let error_msg = send_error.to_string();\n    let host = &request.client_host;",
			"    let error_msg = error_message;\n    let host = &request.client_host;\n    let extra_line = true;",
		);
		fs.writeFileSync(upstreamRs, patchedContent, "utf8");
		guard.recordFileMutation(upstreamRs, session, tmpDir, patchedContent, {
			targetRanges: pre1.targetRange ? [pre1.targetRange] : [],
			deltaLines: 1,
		});

		// 3. Agent runs `cargo test` in bash (fails with line 737)
		guard.recordCommandExecution(
			"cargo test --no-fail-fast",
			tmpDir,
			session,
			false,
			"error[E0063]: missing field in upstream::UpstreamRequest\n --> src/upstream.rs:737:9",
		);

		// 4. Agent edits line 736-737 (Turn 81 in real session)
		const edit2 = `            client_host: "test".to_string(),
        }`;
		const pre2 = preflightSurgicalPatchBlock(upstreamRs, edit2);
		assertPass("Preflight locates edit2", pre2.success && pre2.targetRange !== undefined, { pre2 });

		const res2 = guard.checkReadPrecondition(
			upstreamRs,
			"edit",
			session,
			tmpDir,
			true,
			pre2.targetRange ? [pre2.targetRange] : [],
			[edit2],
		);
		assertPass(
			"FIXED HISTORICAL BUG 1: Agent edits post-mutation without false drift rejection",
			res2.allowed === true,
			{ res2 },
		);

		// -------------------------------------------------------------------------
		// HISTORICAL ROOT CAUSE 2: AMBIGUOUS DUPLICATE SEARCH BLOCK (Session 01a07f1d)
		// Agent edits `if (localHover)` which appears at line 344 AND line 671!
		// -------------------------------------------------------------------------
		guard.recordFileRead(lspToolTs, session, tmpDir, undefined, {
			coverage: { complete: false, ranges: [{ startLine: 340, endLine: 350 }] },
			provenance: "read",
		});

		const duplicateBlock = `						if (localHover) {
							return { content: [{ type: "text", text: localHover }] };
						}`;
		const preDup = preflightSurgicalPatchBlock(lspToolTs, duplicateBlock);
		assertPass(
			"FIXED HISTORICAL BUG 2: preflight accurately flags duplicate match as ambiguous",
			!preDup.success && preDup.isAmbiguous === true && (preDup.error || "").includes("ambiguous"),
			{ preDup },
		);

		// Disambiguated block with 1 line of context
		const disambiguatedBlock = `// Line 343: generic statement or comment in file
						if (localHover) {
							return { content: [{ type: "text", text: localHover }] };
						}`;
		const preDisambiguated = preflightSurgicalPatchBlock(lspToolTs, disambiguatedBlock);
		assertPass("Disambiguated block locates uniquely", preDisambiguated.success, { preDisambiguated });

		const resDisambiguated = guard.checkReadPrecondition(
			lspToolTs,
			"edit",
			session,
			tmpDir,
			true,
			preDisambiguated.targetRange ? [preDisambiguated.targetRange] : [],
			[disambiguatedBlock],
		);
		assertPass(
			"Disambiguated block authorized cleanly under Tier 1",
			resDisambiguated.allowed && resDisambiguated.tier === 1,
			{ resDisambiguated },
		);

		// -------------------------------------------------------------------------
		// HISTORICAL ROOT CAUSE 3: COMPOUND SHELL PIPELINE (Session 01a07bac)
		// Agent runs `echo "..." > /tmp/probe.txt && cat /tmp/probe.txt`
		// -------------------------------------------------------------------------
		const probeFile = path.join(tmpDir, "probe.txt");
		fs.writeFileSync(probeFile, "test edit guard\nline 2\nline 3\n", "utf8");

		guard.recordCommandExecution("cat probe.txt", tmpDir, session, true, "test edit guard\nline 2\nline 3\n");
		const evProbe = guard.getEvidence(probeFile, session, tmpDir);
		assertPass(
			"FIXED HISTORICAL BUG 3: cat output records complete file read",
			evProbe !== null && evProbe.coverage.complete === true,
			{ evProbe },
		);

		const probeEdit = "test edit guard\nline 2\nline 3";
		const preProbe = preflightSurgicalPatchBlock(probeFile, probeEdit);
		const resProbe = guard.checkReadPrecondition(
			probeFile,
			"edit",
			session,
			tmpDir,
			true,
			preProbe.targetRange ? [preProbe.targetRange] : [],
			[probeEdit],
		);
		assertPass("Edit on cat-observed file authorized", resProbe.allowed === true, { resProbe });

		logPass("All historical session root causes verified and fixed on production code!");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
