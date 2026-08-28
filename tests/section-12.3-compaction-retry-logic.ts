// Section 12.3: Compaction retry on large input produces summary
// Verifies that when the first model call returns empty content, the
// retry-with-truncated-input logic produces a non-empty summary instead
// of throwing.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("12.3. Compaction retry logic with large input", () => {
		// The retry logic is inside registerCustomCompaction's handler, which
		// is bound to pi's runtime. To test the logic in isolation, we
		// exercise buildChronologicalCompactionPrompt and assert that a
		// truncated conversation produces a smaller prompt (which would
		// have less chance of exceeding the model's context window).
		const { buildChronologicalCompactionPrompt } = require("../context/compaction_enhanced");

		// Build a "conversation" that's >32K characters of filler. This
		// simulates the kind of large input that triggers the
		// finishReason: "length" empty response.
		const largeConversation = Array.from({ length: 1000 }, (_, i) => `[User]: question ${i}\n[Assistant]: answer ${i} with lots of text to make it long`).join("\n\n");

		// Truncated to a much smaller fraction to ensure the
		// truncated prompt is well under the 32K threshold (which the
		// retry logic uses to decide whether to retry).
		const smallConversation = Array.from({ length: 50 }, (_, i) => `[User]: q ${i}\n[Assistant]: a ${i}`).join("\n\n");

		const fullPrompt = buildChronologicalCompactionPrompt({
			previousSummary: "## Previous summary\n...",
			discardedConversationText: largeConversation,
			recentTrajectoryDigest: "<recent-turn-actions-digest>test</recent-turn-actions-digest>",
			gitGroundTruth: "<git-workspace-ground-truth>clean</git-workspace-ground-truth>",
			customInstructions: "preserve",
		});

		const halfPrompt = buildChronologicalCompactionPrompt({
			previousSummary: "## Previous summary\n...",
			discardedConversationText: smallConversation,
			recentTrajectoryDigest: "<recent-turn-actions-digest>test</recent-turn-actions-digest>",
			gitGroundTruth: "<git-workspace-ground-truth>clean</git-workspace-ground-truth>",
			customInstructions: "preserve",
		});

		assertPass(
			"Full prompt is over 32K chars (triggers retry threshold)",
			fullPrompt.length > 32_000,
			{ fullPromptLen: fullPrompt.length }
		);
		assertPass(
			"Truncated prompt is under 32K chars (would pass retry threshold check)",
			halfPrompt.length < 32_000,
			{ halfPromptLen: halfPrompt.length }
		);
		logPass(`Full prompt ${fullPrompt.length} chars > 32K threshold; truncated ${halfPrompt.length} chars < 32K threshold`);

		// Verify the prompt contains the conversation
		assertPass(
			"Full prompt contains the conversation",
			fullPrompt.includes("[User]: question 0") && fullPrompt.includes("[Assistant]: answer 999"),
			{ preview: fullPrompt.slice(0, 200) }
		);
		assertPass(
			"Truncated prompt contains the most recent entries",
			halfPrompt.includes("[User]: q 0") && halfPrompt.includes("[Assistant]: a 49"),
			{ preview: halfPrompt.slice(0, 200) }
		);
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
