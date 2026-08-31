// Section 12.1: Compaction prompt caching partitioning
// Verifies that the static summarization instructions live in the system
// prompt now (so provider prompt caches can reuse them) and not in the
// user message.

import { buildCompactionSystemPrompt, buildChronologicalCompactionPrompt, ENHANCED_SUMMARIZATION_PROMPT } from "../src/context/compaction_enhanced";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("12.1. Compaction Prompt Caching Partitioning", () => {
		// 1. The system prompt builder returns a string that includes the static instructions.
		const systemPrompt = buildCompactionSystemPrompt();
		assertPass(
			"System prompt includes the static summarization instructions",
			systemPrompt.includes("CRITICAL INSTRUCTIONS FOR CHRONOLOGICAL RECONCILIATION") &&
				systemPrompt.includes("STRICT MONOTONIC TASK RECONCILIATION") &&
				systemPrompt.includes("EPISTEMIC COMPRESSION") &&
				!systemPrompt.includes("3-TIER EPISTEMIC CLASSIFICATION") &&
				systemPrompt.includes("You are a context summarization assistant"),
			{ systemPrompt: systemPrompt.slice(0, 200) }
		);
		logPass("System prompt includes static instructions (cacheable across compactions)");

		// 2. The user message builder does NOT include the static instructions or their status-label guidance.
		const userMessage = buildChronologicalCompactionPrompt({
			previousSummary: "## Progress",
			discardedConversationText: "User: hi\nAssistant: hello",
			recentTrajectoryDigest: "<recent-turn-actions-digest>test</recent-turn-actions-digest>",
			workspaceState: "<workspace-state>clean</workspace-state>",
			customInstructions: "preserve this",
		});
		assertPass(
			"User message does NOT contain the static summarization instructions",
			!userMessage.includes("CRITICAL INSTRUCTIONS FOR CHRONOLOGICAL RECONCILIATION") &&
				!userMessage.includes("STRICT MONOTONIC TASK RECONCILIATION") &&
				!userMessage.includes("3-TIER EPISTEMIC CLASSIFICATION") &&
				!userMessage.includes("EPISTEMIC COMPRESSION") &&
				!userMessage.includes("[VERIFIED]") &&
				!userMessage.includes("[ASSERTED]") &&
				!userMessage.includes("[AMBIGUOUS]"),
			{ userMessage: userMessage.slice(0, 200) }
		);
		logPass("User message is free of static instructions (varies per compaction)");

		// 3. The user message DOES contain the varying data.
		assertPass(
			"User message contains the conversation history",
			userMessage.includes("<discarded-conversation-history>") &&
				userMessage.includes("User: hi") &&
				userMessage.includes("Assistant: hello"),
			{ userMessage: userMessage.slice(0, 300) }
		);
		assertPass(
			"User message contains the Git ground truth",
			userMessage.includes("<git-workspace-ground-truth>") && userMessage.includes("clean"),
			{ userMessage: userMessage.slice(0, 300) }
		);
		assertPass(
			"User message contains the trajectory digest",
			userMessage.includes("<recent-turn-actions-digest>"),
			{ userMessage: userMessage.slice(0, 300) }
		);
		assertPass(
			"User message contains the custom instructions",
			userMessage.includes("preserve this"),
			{ userMessage: userMessage.slice(0, 300) }
		);

		// 4. The system prompt is identical between calls (cacheable).
		//    Note: this is the cacheability property — same string across calls.
		const sysPrompt2 = buildCompactionSystemPrompt();
		assertPass(
			"System prompt is deterministic across calls (cache-friendly)",
			systemPrompt === sysPrompt2,
			{ len1: systemPrompt.length, len2: sysPrompt2.length }
		);

		// 5. The static prompt is the bulk of the system prompt.
		//    The `ENHANCED_SUMMARIZATION_PROMPT` is ~776 tokens (measured).
		//    The system prompt should be: 776 (static) + ~30 (role prefix) = ~806.
		const roleOnly = "You are a context summarization assistant. Produce the structured summary following the exact format specified. Reconcile all tasks against workspace state and recent tool outputs. Do NOT continue the conversation.\n\n";
		assertPass(
			"System prompt is the static instructions plus a short role prefix",
			systemPrompt === roleOnly + ENHANCED_SUMMARIZATION_PROMPT,
			{ systemPromptLen: systemPrompt.length, roleOnlyLen: roleOnly.length, staticPromptLen: ENHANCED_SUMMARIZATION_PROMPT.length }
		);
		logPass(`System prompt is ${systemPrompt.length} chars; static instructions are ${ENHANCED_SUMMARIZATION_PROMPT.length} chars (the cacheable portion)`);
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
