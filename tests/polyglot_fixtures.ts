// Polyglot test fixtures committed as real source files in fixtures/polyglot/.
//
// The `fixtures/` directory is checked in to the repository so reviewers can
// inspect test inputs as actual source files. Fixtures are read on demand
// from disk so that the test sees the same content the production parser
// would encounter.

import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "polyglot");

export const POLYGLOT_FIXTURE_FILES: string[] = [
	"src/app.ts",
	"src/worker.rs",
	"src/router.go",
	"src/PaymentService.java",
	"src/OrderProcessor.cs",
	"src/checksum.c",
	"src/solver.cpp",
	"src/report.rb",
	"src/CacheManager.php",
	"src/deploy.sh",
];

export function getPolyglotFixture(relPath: string): string {
	const fullPath = path.join(FIXTURE_ROOT, relPath);
	return fs.readFileSync(fullPath, "utf8");
}

export function listPolyglotFixturePaths(): string[] {
	return POLYGLOT_FIXTURE_FILES.map((rel) => path.join(FIXTURE_ROOT, rel));
}
