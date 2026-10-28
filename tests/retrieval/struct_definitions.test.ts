import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkFile } from "../../src/retrieval/search_chunker";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";

// Files of at most 40 lines are indexed as one chunk, so both samples are longer than that.
const helpers = (n: number) => Array.from({ length: n }, (_, i) => `int helper${i}(int v) {\n  return v + ${i};\n}\n`).join("\n");

const C = `struct node;

struct node {
  int value;
  struct node *next;
};

struct node *make_node(int value);
static struct node *head = (struct node *)0;

int sum(struct node *n) {
  int total = 0;
  for (; n; n = n->next) total += n->value;
  return total;
}

${helpers(8)}`;

const CPP = `class Widget;

class Widget {
 public:
  int size() const { return 1; }
};

Widget *find_widget(class Widget *w);
static class Widget *last = (class Widget *)nullptr;

${helpers(8)}`;

export async function run(): Promise<void> {
	console.log("=== Running Struct/Class Definition Suite ===");
	await TreeSitterEngine.getInstance().loadLanguages([".c", ".cpp"]);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-struct-defs-"));
	try {
		for (const [file, source, name, defLine] of [["list.c", C, "node", 3], ["widget.cpp", CPP, "Widget", 3]] as const) {
			fs.writeFileSync(path.join(dir, file), source);
			const chunks = chunkFile(dir, path.join(dir, file), source);
			const ids = chunks.map((c) => c.id);
			assert.equal(new Set(ids).size, ids.length, `${file}: duplicate chunk ids ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
			const classes = chunks.filter((c) => c.kind === "class" && c.symbolName === name);
			assert.equal(classes.length, 1, `${file}: expected only the definition of ${name}, got ${classes.map((c) => `${c.startLine}-${c.endLine}`).join(", ")}`);
			assert.equal(classes[0].startLine, defLine, `${file}: the ${name} chunk must be its definition`);
			assert.ok(classes[0].endLine > classes[0].startLine, `${file}: the ${name} definition spans its body`);
			assert.ok(chunks.some((c) => c.symbolName === (file === "list.c" ? "sum" : "helper0")), `${file}: functions are still chunked`);
		}
		console.log("✓ Struct/class references and forward declarations are not chunked as definitions!");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	void run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
