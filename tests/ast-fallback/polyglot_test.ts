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
		// TypeScript: now the realistic fixture has DatabaseOptions/ServerStats/BaseConnection/PostgresPool/AppServer
		const tsPath = path.resolve(ws.tempDir, "src/app.ts");
		const tsDocSyms = extractDocumentSymbols(tsPath);
		const tsSymbolNames = new Set(tsDocSyms.map((s) => s.name));
		assertPass("TS document symbols include DatabaseOptions", tsSymbolNames.has("DatabaseOptions"), { tsDocSyms });
		assertPass("TS document symbols include ServerStats", tsSymbolNames.has("ServerStats"), { tsDocSyms });
		assertPass("TS document symbols include BaseConnection (abstract)", tsSymbolNames.has("BaseConnection"), { tsDocSyms });
		assertPass("TS document symbols include PostgresPool (extends BaseConnection)", tsSymbolNames.has("PostgresPool"), { tsDocSyms });
		assertPass("TS document symbols include AppServer (extends EventEmitter)", tsSymbolNames.has("AppServer"), { tsDocSyms });

		// Rust: new fixture has TaskWorker, AppState, AppStateInner, State, Config
		const rsPath = path.resolve(ws.tempDir, "src/worker.rs");
		const rsDocSyms = extractDocumentSymbols(rsPath);
		assertPass("Rust document symbols include TaskWorker", rsDocSyms.some((s) => s.name === "TaskWorker"), {
			rsDocSyms,
		});
		const rsMethodHits = searchAstSymbols(ws.tempDir, { name: "process_job", filePattern: "worker.rs", exactMatch: true });
		assertPass(
			"searchAstSymbols finds exactly one Rust method 'process_job'",
			rsMethodHits.length === 1 && rsMethodHits[0].name === "process_job" && rsMethodHits[0].kind === "method" && rsMethodHits[0].filePath === "src/worker.rs",
			{ rsMethodHits },
		);

		// Java: new fixture has PaymentService, Currency, MAX_RETRIES, DEFAULT_CURRENCY
		const javaPath = path.resolve(ws.tempDir, "src/PaymentService.java");
		const javaDocSyms = extractDocumentSymbols(javaPath);
		const javaNames = new Set(javaDocSyms.map((s) => s.name));
		assertPass("Java document symbols include PaymentService", javaNames.has("PaymentService"), { javaDocSyms });
		assertPass("Java document symbols include Currency enum", javaNames.has("Currency"), { javaDocSyms });

		// Go: new fixture has FileStore, Router, Middleware, InitRouter
		const goPath = path.resolve(ws.tempDir, "src/router.go");
		const goDocSyms = extractDocumentSymbols(goPath);
		const goNames = new Set(goDocSyms.map((s) => s.name));
		assertPass("Go document symbols include InitRouter", goNames.has("InitRouter"), { goDocSyms });
		assertPass("Go document symbols include FileStore", goNames.has("FileStore"), { goDocSyms });
		assertPass("Go document symbols include Router", goNames.has("Router"), { goDocSyms });

		// searchAstSymbols across all languages
		const allResults = searchAstSymbols(ws.tempDir, { name: "PaymentService", exactMatch: true });
		assertPass(
			"searchAstSymbols finds PaymentService class without leaking the constructor",
			allResults.length === 2 && allResults.every((result) => result.name === "PaymentService") &&
				allResults.filter((result) => result.kind === "class").length === 1 &&
				allResults.filter((result) => result.kind === "method").length === 1 &&
				allResults.every((result) => result.filePath === "src/PaymentService.java"),
			{ allResults },
		);

		logPass("Polyglot AST extensions across TS, Rust, Java, and Go passed!");
	} finally {
		ws.cleanup();
	}
}
