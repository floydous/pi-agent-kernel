import assert from "node:assert/strict";
import { extractFileTags } from "../../src/retrieval/tag_extractor";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";

const SOURCE = `import { readFile as read } from "node:fs";
import Default, { join as joinPath } from "node:path";
export { helper as publicHelper } from "./helpers";

export function withoutBase(input: string, base: string) {
	// Ensure '/admin-dashboard' is not considered as having base '/admin/'
	const value = input as unknown;
	return (value as any).slice(base.length);
}

export class Context {
	get env() {
		return this.raw as Record<string, string>;
	}
}

export const settings = { mode: "strict" } as const;

export default { label: "x" as string };
`;

export async function run(): Promise<void> {
	console.log("=== Running Alias Extraction Tests ===");
	await TreeSitterEngine.getInstance().loadLanguages([".ts"]);
	const defs = extractFileTags("src/sample.ts", SOURCE).definitions;
	const aliases = defs.filter((d) => d.kind === "alias").map((d) => d.name).sort();

	console.log("1. Real import/export aliases are extracted...");
	assert.deepEqual(aliases, ["joinPath", "publicHelper", "read"], `unexpected aliases: ${JSON.stringify(aliases)}`);

	console.log("2. 'x as y' text inside exported declarations does not create aliases...");
	for (const junk of ["having", "unknown", "any", "Record", "const", "string"]) {
		assert.ok(!defs.some((d) => d.kind === "alias" && d.name === junk), `junk alias '${junk}' extracted`);
	}

	console.log("3. The exported declarations themselves are still extracted once...");
	assert.equal(defs.filter((d) => d.name === "withoutBase").length, 1, "withoutBase must be a single definition");
	assert.ok(defs.some((d) => d.name === "Context" && d.kind === "class"), "class Context must be extracted");

	console.log("✓ Alias extraction ignores 'as' text inside exported declarations!");
}
