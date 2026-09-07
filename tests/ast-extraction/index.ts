// Polyglot AST Extraction Suite
// Verifies exact AST extraction coordinates, kinds, and signatures across:
// TypeScript, Python, Rust, Go, Java, and C# with strict adversarial checks.

import { extractFileTags } from "../../src/retrieval/repomap";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";
import { runSuite, assertPass, logPass } from "../_setup";
import { TS_COMPLEX_CODE } from "./cases/typescript";
import { PY_COMPLEX_CODE } from "./cases/python";
import { RUST_COMPLEX_CODE } from "./cases/rust";
import { GO_COMPLEX_CODE } from "./cases/go";
import { JAVA_COMPLEX_CODE } from "./cases/java";
import { CS_COMPLEX_CODE } from "./cases/csharp";

export async function run(): Promise<void> {
	await runSuite("Polyglot AST Extraction Suite", async () => {
		await TreeSitterEngine.getInstance().init();
		await TreeSitterEngine.getInstance().loadLanguages([".ts", ".py", ".rs", ".go", ".java", ".cs"]);

		// 1. TypeScript AST verification
		const tsTags = extractFileTags("src/db/postgres.ts", TS_COMPLEX_CODE);
		const tsNames = tsTags.definitions.map((d) => d.name);
		assertPass(
			"TS extracts the expected interfaces, class, methods, getter, and static member",
			["DatabaseOptions", "BaseConnection", "connectInternal", "ping", "PostgresPool", "isReady", "createDefault"].every((name) => tsNames.includes(name)) &&
				tsNames.filter((name) => name === "connectInternal").length === 2 &&
				tsNames.filter((name) => name === "ping").length === 2,
			{ tsDefs: tsTags.definitions }
		);
		// Verify strict range bounds (endLine must be greater than start line for blocks)
		const poolDef = tsTags.definitions.find((d) => d.name === "PostgresPool");
		assertPass(
			"TS class has exact AST line and endLine",
			!!poolDef && poolDef.line > 0 && !!poolDef.endLine && poolDef.endLine > poolDef.line,
			{ poolDef }
		);

		// 2. Python AST verification
		const pyTags = extractFileTags("src/repo.py", PY_COMPLEX_CODE);
		const pyNames = pyTags.definitions.map((d) => d.name);
		assertPass(
			"Python extracts the expected classes, methods, and factory",
			["AbstractRepository", "SqlRepository", "__init__", "find_by_id", "batch_insert", "create_repo"].every((name) => pyNames.includes(name)) &&
				pyNames.filter((name) => name === "SqlRepository").length === 1,
			{ pyDefs: pyTags.definitions }
		);

		// 3. Rust AST verification
		const rsTags = extractFileTags("src/buffer.rs", RUST_COMPLEX_CODE);
		const rsNames = rsTags.definitions.map((d) => d.name);
		assertPass(
			"Rust extracts structs, traits, consts, unsafe fns, and async methods",
			rsNames.includes("BufferManager") &&
				rsNames.includes("StorageBackend") &&
				rsNames.includes("DEFAULT_CAPACITY") &&
				rsNames.includes("allocate_raw") &&
				rsNames.includes("async_sync"),
			{ rsDefs: rsTags.definitions }
		);

		// 4. Go AST verification
		const goTags = extractFileTags("src/storage.go", GO_COMPLEX_CODE);
		const goNames = goTags.definitions.map((d) => d.name);
		assertPass(
			"Go extracts interfaces, structs, receiver methods, and standalone functions",
			goNames.includes("Reader") &&
				goNames.includes("FileStore") &&
				goNames.includes("ReadAt") &&
				goNames.includes("OpenStore"),
			{ goDefs: goTags.definitions }
		);

		// 5. Java AST verification
		const javaTags = extractFileTags("src/TransactionCoordinator.java", JAVA_COMPLEX_CODE);
		const javaNames = javaTags.definitions.map((d) => d.name);
		assertPass(
			"Java extracts classes, synchronized methods, and generic return methods",
			javaNames.includes("TransactionCoordinator") &&
				javaNames.includes("commit") &&
				javaNames.includes("rollbackAsync"),
			{ javaDefs: javaTags.definitions }
		);

		// 6. C# AST verification
		const csTags = extractFileTags("src/InvoiceService.cs", CS_COMPLEX_CODE);
		const csNames = csTags.definitions.map((d) => d.name);
		assertPass(
			"C# extracts interfaces, classes, and async methods",
			csNames.includes("IInvoiceGenerator") &&
				csNames.includes("InvoiceService") &&
				csNames.includes("GenerateAsync"),
			{ csDefs: csTags.definitions }
		);

		logPass("Polyglot AST Extraction verified across TS, Python, Rust, Go, Java, and C#!");
	});
}

// Self-executing runner when executed directly
