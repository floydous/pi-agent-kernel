import * as path from "node:path";
import {
	extractDocumentSymbols,
	searchAstSymbols,
} from "../../src/retrieval/ast_search";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export async function testPolyglotAstExtensions(): Promise<void> {
	const ws = createPolyglotWorkspace("fallback_polyglot_");
	try {
		// Pre-warm the Tree-sitter engine with the language extensions
		// that exist in the polyglot workspace so the AST search can find
		// class methods, getters, and other deeply-nested declarations.
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".ts", ".rs", ".go", ".java"]);
		// TypeScript class
		const tsPath = path.resolve(ws.tempDir, "src/app.ts");
		const tsDocSyms = extractDocumentSymbols(tsPath);
		assertPass("TS document symbols include ServerConfig", tsDocSyms.some((s) => s.name === "ServerConfig"), {
			tsDocSyms,
		});
		assertPass("TS document symbols include AppServer", tsDocSyms.some((s) => s.name === "AppServer"), {
			tsDocSyms,
		});
		const tsMethodHits = searchAstSymbols(ws.tempDir, { name: "start", filePattern: "app.ts" });
		assertPass("searchAstSymbols finds TS method 'start'", tsMethodHits.length > 0, { tsMethodHits });

		// Rust struct/methods
		const rsPath = path.resolve(ws.tempDir, "src/worker.rs");
		const rsDocSyms = extractDocumentSymbols(rsPath);
		assertPass("Rust document symbols include TaskWorker", rsDocSyms.some((s) => s.name === "TaskWorker"), {
			rsDocSyms,
		});
		const rsMethodHits = searchAstSymbols(ws.tempDir, { name: "process_job", filePattern: "worker.rs" });
		assertPass("searchAstSymbols finds Rust method 'process_job'", rsMethodHits.length > 0, { rsMethodHits });

		// Java
		const javaPath = path.resolve(ws.tempDir, "src/PaymentService.java");
		const javaDocSyms = extractDocumentSymbols(javaPath);
		assertPass("Java document symbols include PaymentService", javaDocSyms.some((s) => s.name === "PaymentService"), {
			javaDocSyms,
		});

		// Go
		const goPath = path.resolve(ws.tempDir, "src/router.go");
		const goDocSyms = extractDocumentSymbols(goPath);
		assertPass("Go document symbols include InitRouter", goDocSyms.some((s) => s.name === "InitRouter"), {
			goDocSyms,
		});

		// searchAstSymbols across all languages
		const allResults = searchAstSymbols(ws.tempDir, { name: "PaymentService" });
		assertPass("searchAstSymbols finds PaymentService across the polyglot workspace", allResults.length > 0, {
			allResults,
		});

		logPass("Polyglot AST extensions across TS, Rust, Java, and Go passed!");
	} finally {
		ws.cleanup();
	}
}
