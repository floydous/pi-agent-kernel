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
	assert(!one.text.includes("[code_search"));

	const several = formatCodeSearchResults(
		[hit(0, body), hit(1, body), hit(2, body)],
		"retry error",
		"auto",
	);
	assertPass("Several results use bounded previews", several.mode === "preview" && several.text.includes("retry error"), several);
	assert(several.text.length <= 8_000);
	assert(!several.text.includes("mode: \"full\""));
	assert(!several.text.startsWith("[code_search"));

	const many = formatCodeSearchResults(
		Array.from({ length: 8 }, (_, index) => hit(index, body)),
		"retry error",
		"auto",
	);
	const tail = many.text.slice(many.text.indexOf("src/file5.rs"));
	assertPass("Many results preserve previews and summarize the tail", many.mode === "mixed" && tail.includes("src/file7.rs") && !tail.includes("```"), many);
	assert(many.text.length <= 8_000);
	assert(many.text.startsWith("8 matches returned; first 5 shown as previews, remaining 3 summarized."));

	// A mid-size chunk (here 40 lines, under 2,000 chars) is shown whole, so lines far from the query term stay visible.
	const midBody = Array.from({ length: 40 }, (_, index) => index === 1 ? "  // retry error" : index === 38 ? "  changed_line();" : `  step${index}();`).join("\n");
	const mid = formatCodeSearchResults([hit(0, midBody), hit(1, body), hit(2, body), hit(3, body)], "retry error", "auto");
	assertPass(
		"Mid-size previewed chunks are shown whole with their full range",
		mid.text.includes("changed_line();") && !mid.text.includes("omitted ...") &&
			JSON.stringify(mid.visibleRanges[0]) === JSON.stringify({ chunkId: hit(0, midBody).chunk.id, startLine: 1, endLine: 40 }),
		mid,
	);
	assert(!many.text.includes("mode=auto->mixed"));

	const summary = formatCodeSearchResults([hit(0, body), hit(1, body)], "retry", "summary");
	assertPass("Explicit summary omits code bodies", summary.mode === "summary" && !summary.text.includes("return unrelated"), summary);
	assert(!summary.text.includes("[code_search"));

	const full = formatCodeSearchResults([hit(0, body)], "retry", "full");
	assertPass("Explicit full preserves code bodies", full.mode === "full" && full.text.startsWith("src/file0.rs:") && full.text.includes("return unrelated"), full);
	assert(!full.text.includes("[code_search"));

	// Over the 2,000-char whole-chunk limit, so the preview must be a window around the query-bearing line.
	const longBody = Array.from({ length: 100 }, (_, index) => index === 50 ? "retry error target" : `unrelated line ${index} with padding`).join("\n");
	const boundedPreview = formatCodeSearchResults(
		[hit(0, longBody), hit(1, longBody), hit(2, longBody)],
		"retry error",
		"auto",
	);
	assertPass(
		"Automatic previews preserve query-bearing lines from large chunks",
		boundedPreview.mode === "preview" &&
			boundedPreview.text.includes("retry error target") &&
			boundedPreview.text.includes("... lines 1-") &&
			!boundedPreview.text.includes("unrelated line 0 with padding"),
		boundedPreview,
	);

	const empty = formatCodeSearchResults([], "retry", "auto");
	assertPass("Empty auto output has no diagnostic header", !empty.text.includes("[code_search"), empty);

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

	const autoClipped = formatCodeSearchResults(
		Array.from({ length: 100 }, (_, index) => hit(index, clippingBody)),
		"retry error",
		"auto",
	);
	assertPass(
		"Automatic mixed clipping keeps the semantic notice within budget",
		autoClipped.truncated &&
			autoClipped.text.startsWith("100 matches returned; first 5 shown as previews, remaining 95 summarized.") &&
			autoClipped.text.length <= 8_000,
		autoClipped,
	);

	logPass("Adaptive code-search output formatting verified!");
}

export function run(): void {
	testOutputFormatting();
}
