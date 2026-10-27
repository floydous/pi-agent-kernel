import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkFile, findChunkableFiles } from "../../src/retrieval/search_chunker";
import { extractFileTags } from "../../src/retrieval/tag_extractor";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";

// Files of at most 40 lines are indexed as one chunk, so every sample is longer than that.
const helpers = (n: number) => Array.from({ length: n }, (_, i) => `int helper${i}(int v) {\n  return v + ${i};\n}\n`).join("\n");

const CPP = `#include <string>

namespace demo {

class Greeter {
 public:
  explicit Greeter(std::string name) : name_(std::move(name)) {}
  std::string greet() const {
    return "hello " + name_;
  }
  int length() const {
    return static_cast<int>(name_.size());
  }

 private:
  std::string name_;
};

template <typename T>
T twice(T value) {
  return value + value;
}

int add(int a, int b) {
  return a + b;
}

${helpers(6)}
}  // namespace demo
`;

const C_CLEAN = `#ifndef DEMO_BUFFER_H
#define DEMO_BUFFER_H

#include <stddef.h>

struct buffer {
  char* data;
  size_t len;
};

static inline size_t buffer_len(const struct buffer* b) {
  return b->len;
}

static inline char* buffer_data(struct buffer* b) {
  return b->data;
}

${helpers(6)}
#endif
`;

// Macro-heavy C (a field-list macro inside a struct) parses with errors but has no C++ markers.
const C_MACRO = `#ifndef DEMO_REQ_H
#define DEMO_REQ_H

#define DEMO_EXTERN extern
#define DEMO_REQ_FIELDS \\
  int a;                \\
  int b;

/* Abstract base class of all requests. */
struct demo_req {
  DEMO_REQ_FIELDS
  void* data;
};

DEMO_EXTERN int demo_init(struct demo_req* req);

static inline int demo_sum(struct demo_req* r) {
  return r->a + r->b;
}

${helpers(6)}
#endif
`;

const shape = (chunks: any[]) => chunks.map((c) => `${c.startLine}-${c.endLine}#${c.symbolName}#${c.kind}`);
const names = (chunks: any[]) => chunks.map((c) => c.symbolName);

export async function run(): Promise<void> {
	console.log("=== Running C++ Indexing Tests ===");
	const engine = TreeSitterEngine.getInstance();
	await engine.loadLanguages([".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh", ".hxx"]);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-indexing-"));
	const write = (name: string, content: string) => {
		const file = path.join(dir, name);
		fs.writeFileSync(file, content);
		return file;
	};
	const failures: string[] = [];
	const section = (label: string, body: () => void) => {
		console.log(label);
		try {
			body();
		} catch (error: any) {
			failures.push(`${label} ${error.message.split("\n")[0]}`);
		}
	};
	try {
		section("T1. .cc/.cxx/.hh/.hxx files are walked and chunked with the C++ grammar...", () => {
			const exts = [".cc", ".cxx", ".hh", ".hxx"];
			for (const ext of exts) write(`sample${ext}`, CPP);
			const walked = findChunkableFiles(dir).map((f) => path.basename(f));
			for (const ext of exts) {
				assert.ok(walked.includes(`sample${ext}`), `sample${ext} is not walked`);
				const chunkNames = names(chunkFile(dir, path.join(dir, `sample${ext}`), CPP));
				for (const expected of ["Greeter", "greet", "length", "twice", "add"]) {
					assert.ok(chunkNames.includes(expected), `${ext}: missing ${expected} in ${chunkNames.join(",")}`);
				}
			}
		});

		section("T2. A .h file with C++ content chunks like the same text saved as .hpp...", () => {
			const asH = chunkFile(dir, write("cpp_header.h", CPP), CPP);
			const asHpp = chunkFile(dir, write("cpp_header.hpp", CPP), CPP);
			assert.ok(names(asHpp).includes("greet"));
			assert.deepEqual(shape(asH), shape(asHpp));
		});

		section("T3. Plain and macro-heavy C headers keep the C grammar's chunks...", () => {
			const cParser = engine.getParser(".h")!;
			const tree = cParser.parse(C_MACRO);
			const macroHasErrors = tree.rootNode.hasError;
			tree.delete();
			assert.equal(macroHasErrors, true, "precondition: the macro-heavy sample must have C parse errors");
			for (const [name, text] of [["clean", C_CLEAN], ["macro", C_MACRO]] as const) {
				const asH = chunkFile(dir, write(`${name}.h`, text), text);
				const asC = chunkFile(dir, write(`${name}.c`, text), text);
				assert.deepEqual(shape(asH), shape(asC), `${name}.h is not chunked like C`);
			}
		});

		section("T4. A C header whose comment says \"class\" stays C...", () => {
			const text = C_MACRO.replace("/* Abstract base class of all requests. */", "/* Abstract base class of all requests: see demo_req. */");
			const asH = chunkFile(dir, write("comment.h", text), text);
			const asC = chunkFile(dir, write("comment.c", text), text);
			assert.deepEqual(shape(asH), shape(asC));
		});

		section("T5. Without grammars, the regex fallback still chunks .cc/.cxx/.hh/.hxx...", () => {
			const original = engine.extractTags;
			(engine as any).extractTags = () => null;
			try {
				for (const ext of [".cc", ".cxx", ".hh", ".hxx"]) {
					const defs = extractFileTags(`fallback${ext}`, CPP).definitions.map((d) => d.name);
					assert.ok(defs.includes("Greeter") && defs.includes("add"), `${ext}: fallback found ${defs.join(",")}`);
					assert.ok(chunkFile(dir, write(`fallback${ext}`, CPP), CPP).length > 1, `${ext}: fallback produced no entity chunks`);
				}
			} finally {
				(engine as any).extractTags = original;
			}
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	if (failures.length > 0) throw new Error(`C++ indexing failures:\n${failures.join("\n")}`);
	console.log("✓ C++ files and headers are indexed with the C++ grammar; C headers are unchanged!");
}

if (require.main === module) {
	void run();
}
