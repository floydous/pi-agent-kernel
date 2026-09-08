import assert from "node:assert/strict";
import { formatCodeSearchResults } from "../../src/tools/code_search_output";
import type { SearchHit } from "../../src/retrieval/search_index";
import { assertPass, logPass } from "../_setup";

function hit(index: number, content: string, filePath = `src/file${index}.rs`): SearchHit {
	return {
		chunk: {
			id: `${filePath}:1-${content.split("\n").length}#symbol${index}`,
			filePath,
			absolutePath: `/tmp/${filePath}`,
			startLine: 1,
			endLine: content.split("\n").length,
			symbolName: `symbol${index}`,
			kind: "function",
			signature: `fn symbol${index}()`,
			breadcrumb: `// [File: ${filePath}] > [FUNCTION: symbol${index}]`,
			content,
			textForEmbedding: content,
			hash: `hash${index}`,
		},
		rrfScore: 1 / (index + 1),
		bm25Score: 1,
		vectorScore: 0,
		 signal: "lexical",
		matches: ["retry", "error"],
	};
}

export function testOutputFormatting(): void {
	const body = [
		"fn symbol0() {",
		"  let unrelated = true;",
		"  // retry error handling is here",
		"  return unrelated;",
		"}",
	].join("\n");
	const one = formatCodeSearchResults([hit(0, body)], "retry error", "auto");
	assertPass("One small result stays full in auto mode", one.mode === "full" && one.text.includes("return unrelated"), one);

	const several = formatCodeSearchResults(
		[hit(0, body), hit(1, body), hit(2, body)],
		"retry error",
		"auto",
	);
	assertPass("Several results use bounded previews", several.mode === "preview" && several.text.includes("retry error"), several);
	assert(several.text.length <= 8_000);
	assert(!several.text.includes("mode: \"full\""));

	const many = formatCodeSearchResults(
		Array.from({ length: 8 }, (_, index) => hit(index, body)),
		"retry error",
		"auto",
	);
	const tail = many.text.slice(many.text.indexOf("src/file3.rs"));
	assertPass("Many results preserve previews and summarize the tail", many.mode === "mixed" && tail.includes("src/file7.rs") && !tail.includes("```"), many);
	assert(many.text.length <= 8_000);

	const summary = formatCodeSearchResults([hit(0, body), hit(1, body)], "retry", "summary");
	assertPass("Explicit summary omits code bodies", summary.mode === "summary" && !summary.text.includes("return unrelated"), summary);

	const full = formatCodeSearchResults([hit(0, body)], "retry", "full");
	assertPass("Explicit full preserves code bodies", full.mode === "full" && full.text.startsWith("src/file0.rs:") && full.text.includes("return unrelated"), full);

	const longBody = Array.from({ length: 100 }, (_, index) => index === 50 ? "retry error target" : "unrelated line").join("\n");
	const boundedPreview = formatCodeSearchResults(
		[hit(0, longBody), hit(1, longBody), hit(2, longBody)],
		"retry error",
		"auto",
	);
	assertPass(
		"Automatic previews preserve query-bearing lines from large chunks",
		boundedPreview.mode === "preview" &&
			boundedPreview.text.includes("retry error target") &&
			!boundedPreview.text.includes("unrelated line\nunrelated line\nunrelated line\nunrelated line\nunrelated line\nunrelated line\nunrelated line\nunrelated line\nunrelated line\nunrelated line"),
		boundedPreview,
	);

	const clippingBody = Array.from(
		{ length: 100 },
		(_, index) => index === 50 ? "retry error target" : "unrelated line ".repeat(20),
	).join("\n");
	const clipped = formatCodeSearchResults(
		Array.from({ length: 15 }, (_, index) => hit(index, clippingBody)),
		"retry error",
		"preview",
	);
	assertPass(
		"Budget clipping reports omitted matches without claiming an exact body",
		clipped.truncated && clipped.text.includes("additional match") && clipped.text.length <= 8_000,
		clipped,
	);

	logPass("Adaptive code-search output formatting verified!");
}

export function run(): void {
	testOutputFormatting();
}
