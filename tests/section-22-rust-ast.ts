// Section 22: Rust Full AST, Struct Bleed Defense, Variable Hover, Comment Filtering

import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractDocumentSymbols,
	findSymbolReferences,
	extractLocalSymbolHover,
} from "../src/retrieval/ast_search";
import { createTestWorkspace, runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection(
		"22. Rust Full AST, Struct Bleed Defense, Variable Hover, Comment Filtering",
		async () => {
			const ws = createTestWorkspace();
			try {
				const rsSrcDir = path.join(ws.tempDir, "src", "rust_engine");
				fs.mkdirSync(rsSrcDir, { recursive: true });

				const rsStatePath = path.join(rsSrcDir, "state.rs");
				fs.writeFileSync(
					rsStatePath,
					`pub static ENABLED: bool = true;

pub struct AppStateInner {
    pub active_connections: usize,
}

pub enum State {
    Open,
    HalfOpen,
    Closed,
}

impl State {
    pub fn record_success(&self) {
        let mut port: u16 = 8000;
        let client_count = 10;
    }
}
`,
					"utf8",
				);

				const rsCircuitPath = path.join(rsSrcDir, "circuit_breaker.rs");
				fs.writeFileSync(
					rsCircuitPath,
					`pub struct CircuitBreaker;

impl CircuitBreaker {
    pub fn record_success(&self) {
        // The exhaustion check in pick_key_client runs before fallback
        let client = pick_key_client();
    }
}

pub fn pick_key_client() -> bool {
    true
}
`,
					"utf8",
				);

				// 11.1 Test Struct / Enum Signature Bleed Prevention
				const stateDocSyms = extractDocumentSymbols(rsStatePath);
				const enumState = stateDocSyms.find((s) => s.name === "State");
				assertPass(
					"Rust struct/enum snippet bleed prevention for 'enum State'",
					!!enumState &&
						!enumState.signature.includes("impl State") &&
						!enumState.signature.includes("record_success"),
					{ enumState },
				);
				assertPass(
					"Rust enum signature is exact 'pub enum State'",
					enumState?.signature === "pub enum State",
					{ signature: enumState?.signature },
				);
				logPass(
					"Rust struct/enum snippet bleed prevention verified ('pub enum State')!",
				);

				// 11.2 Test Rust Local Variable & Static Variable Hover
				const rsVarHover = extractLocalSymbolHover(rsStatePath, 16, 12, "port");
				assertPass(
					"Rust local variable hover for 'let mut port: u16 = 8000;'",
					!!rsVarHover && rsVarHover.includes("(local variable) port: u16 = 8000"),
					{ rsVarHover },
				);
				logPass(
					"Rust local variable hover verified ('(local variable) port: u16 = 8000')!",
				);

				const rsStaticHover = extractLocalSymbolHover(
					rsStatePath,
					0,
					12,
					"ENABLED",
				);
				assertPass(
					"Rust static variable hover for 'ENABLED'",
					!!rsStaticHover && rsStaticHover.includes("ENABLED: bool = true"),
					{ rsStaticHover },
				);
				logPass("Rust static variable hover verified ('ENABLED: bool = true')!");

				// 11.3 Test Local File Method Hover Priority
				const localMethodHover = extractLocalSymbolHover(
					rsStatePath,
					15,
					12,
					"record_success",
				);
				assertPass(
					"Local file method hover prioritizes state.rs over circuit_breaker.rs",
					!!localMethodHover && localMethodHover.includes("state.rs"),
					{ localMethodHover },
				);
				logPass("Local file method hover prioritization verified!");

				// 11.4 Test Comment Word Filtering on References
				const pickClientRefs = findSymbolReferences(ws.tempDir, "pick_key_client");
				const hasCommentRef = pickClientRefs.some((r) =>
					r.lineText.startsWith("//"),
				);
				assertPass(
					"Comment word filtering: no references returned from comments",
					!hasCommentRef,
					{ pickClientRefs },
				);
				assertPass(
					"Valid code references for pick_key_client exist",
					pickClientRefs.length > 0,
					{ pickClientRefs },
				);
				logPass(
					`Comment word token filtering verified (${pickClientRefs.length} real code reference(s), 0 comment false positives)!`,
				);

				// 11.5 Test lsp tool keyword-bypass & symbol-name queries on Rust declarations
				let registeredTool: any = null;
				const mockPi = {
					registerTool: (t: any) => { registeredTool = t; }
				};
				const { registerLspTool } = require("../src/tools/lsp_tool");
				registerLspTool(mockPi);

				// Query references by symbol parameter
				const symRefRes = await registeredTool.execute("call-sym-ref", {
					action: "references",
					path: rsCircuitPath,
					symbol: "pick_key_client"
				}, undefined, () => {}, { cwd: ws.tempDir });
				assertPass(
					"LSP references resolves by symbol parameter without explicit coordinates",
					symRefRes.content?.[0]?.text?.includes("pick_key_client") &&
						!symRefRes.content?.[0]?.text?.includes("No references found"),
					{ symRefRes }
				);

				// Query references at line: 1, character: 1 (on `pub struct CircuitBreaker;`)
				const lineColRefRes = await registeredTool.execute("call-col1-ref", {
					action: "references",
					path: rsCircuitPath,
					line: 1,
					character: 1
				}, undefined, () => {}, { cwd: ws.tempDir });
				assertPass(
					"LSP references at column 1 advances past 'pub struct' to resolve CircuitBreaker",
					lineColRefRes.content?.[0]?.text?.includes("CircuitBreaker"),
					{ lineColRefRes }
				);
				const { LspManager } = require("../src/lsp/lsp_manager");
				await LspManager.getInstance().stopAll();
				LspManager.getInstance().stopReaper();
				logPass("LSP declaration keyword bypass & symbol parameter query verified!");
			} finally {
				ws.cleanup();
			}
		},
	);
}

main().catch((err) => {
	console.error(err);
	throw err;
});
