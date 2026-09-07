import * as path from "node:path";
import { extractSymbolContent } from "../../src/retrieval/symbol_reader";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export async function testPolyglotSymbolReader(): Promise<void> {
	const ws = createPolyglotWorkspace("sym_reader_polyglot_");
	try {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".ts", ".rs", ".go", ".java", ".py"]);

		// 1. TypeScript class method
		const tsPath = path.join(ws.tempDir, "src/app.ts");
		const tsRes = extractSymbolContent(tsPath, "start");
		assertPass("TS extracts 'start' method", tsRes.found && tsRes.symbols.length === 1, { tsRes });
		assertPass(
			"TS 'start' method has valid range and signature",
			tsRes.symbols[0].content.includes("public async start") && tsRes.symbols[0].startLine > 0,
			{ s: tsRes.symbols[0] }
		);

		// 2. Rust async method
		const rsPath = path.join(ws.tempDir, "src/worker.rs");
		const rsRes = extractSymbolContent(rsPath, "process_job");
		assertPass("Rust extracts 'process_job' method", rsRes.found && rsRes.symbols.length === 1, { rsRes });
		assertPass(
			"Rust 'process_job' has valid async content",
			rsRes.symbols[0].content.includes("pub async fn process_job"),
			{ s: rsRes.symbols[0] }
		);

		// 3. Java method (new fixture has commit/refund/rollbackAsync, no executeTransaction)
		const javaPath = path.join(ws.tempDir, "src/PaymentService.java");
		const javaRes = extractSymbolContent(javaPath, "commit");
		assertPass("Java extracts 'commit' method", javaRes.found && javaRes.symbols.length === 1, { javaRes });
		assertPass(
			"Java 'commit' has valid synchronized content",
			javaRes.symbols[0].content.includes("public synchronized boolean commit"),
			{ s: javaRes.symbols[0] }
		);

		// 4. Go function
		const goPath = path.join(ws.tempDir, "src/router.go");
		const goRes = extractSymbolContent(goPath, "InitRouter");
		assertPass("Go extracts 'InitRouter' function", goRes.found && goRes.symbols.length === 1, { goRes });
		assertPass(
			"Go 'InitRouter' has valid signature",
			goRes.symbols[0].content.includes("func InitRouter"),
			{ s: goRes.symbols[0] }
		);

		logPass("Polyglot targeted symbol reader passed across TS, Rust, Java, and Go!");
	} finally {
		ws.cleanup();
	}
}
