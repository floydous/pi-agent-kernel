// Standalone cold-process script. Run via:
//   npx tsx tests/diagnostics/cold-process-probe.ts <filePath> <expectedName1> <expectedName2> ...
import { extractFileTags } from "../../src/retrieval/repomap";
import * as fs from "node:fs";

const filePath = process.argv[2];
const expectedNames = process.argv.slice(3);

if (!filePath) {
	console.log(JSON.stringify({ error: "filePath argument required" }));
	process.exit(1);
}

const content = fs.readFileSync(filePath, "utf8");
const tags = extractFileTags(filePath, content);
const definitions = tags.definitions.map(({ name, kind, line }) => ({ name, kind, line }));
const found = new Set(definitions.map((d) => d.name));
const missing = expectedNames.filter((n) => !found.has(n));
console.log(JSON.stringify({ total: definitions.length, definitions, found: [...found], missing }));
