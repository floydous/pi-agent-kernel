// Section 12: Epistemically-Grounded Chronological Compaction Engine
// Tests the compaction prompt builder, workspace state extraction, and
// trajectory digest extraction.

import {
	extractWorkspaceState,
	extractTrajectoryDigest,
	buildChronologicalCompactionPrompt,
} from "../src/context/compaction_enhanced";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection(
		"12. Epistemically-Grounded Chronological Compaction Engine",
		() => {
			// Test 1: Workspace State Extraction
			const workspaceState = extractWorkspaceState(process.cwd());
			assertPass(
				"Workspace state extraction verified",
				workspaceState.includes("<workspace-state>") &&
					workspaceState.includes("<workspace-state>") &&
					workspaceState.includes("</workspace-state>"),
				{ workspaceState },
			);
			logPass("Workspace state extraction verified!");

			// Test 2: Recent Trajectory Digest Extraction from Kept Turns
			const mockBranchEntries = [
				{
					type: "message",
					message: {
						role: "user",
						content: "Implement Strategy 2 output clamping.",
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								toolName: "edit",
								args: { path: "features/output_clamper.ts" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "edit",
						isError: false,
						content: [
							{ type: "text", text: "[EDIT SUCCESS] Applied via exact strategy." },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								toolName: "bash",
								args: { command: "npx tsx tests/run-all.ts" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "bash",
						isError: false,
						content: [{ type: "text", text: "ALL 11 TESTS PASSED" }],
					},
				},
			];

			const trajectoryDigest = extractTrajectoryDigest(mockBranchEntries);
			assertPass(
				"Trajectory digest extraction works",
				trajectoryDigest.includes("<recent-turn-actions-digest>") &&
					trajectoryDigest.includes(
						'[User Prompt]: "Implement Strategy 2 output clamping."',
					) &&
					trajectoryDigest.includes(
						'[Assistant Call]: edit({"path":"features/output_clamper.ts"})',
					) &&
					trajectoryDigest.includes(
						"[Tool Result bash]: SUCCESS -> ALL 11 TESTS PASSED",
					),
				{ trajectoryDigest },
			);
			logPass("Trajectory digest extraction across kept turns verified!");

			// Test 3: Chronological Prompt Topology and Monotonic Reconciliation Invariants.
			// After the system-prompt refactor, the static `ENHANCED_SUMMARIZATION_PROMPT`
			// no longer lives in the user message — it's in the system prompt now (so
			// providers' prompt caches can reuse it across compactions). The user
			// message here should NOT contain the static instructions.
			const samplePrevSummary = `## Progress\n### In Progress\n- [ ] Implement Strategy 2`;
			const prompt = buildChronologicalCompactionPrompt({
				previousSummary: samplePrevSummary,
				discardedConversationText: "User: start strategy 2\nAssistant: planning...",
				recentTrajectoryDigest: trajectoryDigest,
				workspaceState,
				customInstructions: "Preserve all error codes",
			});

			const idxBaseline = prompt.indexOf("<historical-summary-baseline>");
			const idxDiscarded = prompt.indexOf("<discarded-conversation-history>");
			const idxTrajectory = prompt.indexOf("<recent-turn-actions-digest>");
			const idxWorkspace = prompt.indexOf("<workspace-state>");

			assertPass(
				"Chronological prompt topology sequence is correct",
				idxBaseline !== -1 &&
					idxDiscarded !== -1 &&
					idxTrajectory !== -1 &&
					idxWorkspace !== -1 &&
					idxBaseline < idxDiscarded &&
					idxDiscarded < idxTrajectory &&
					idxTrajectory < idxWorkspace,
				{ idxBaseline, idxDiscarded, idxTrajectory, idxWorkspace },
			);
			assertPass(
				"User message no longer contains static summarization instructions (moved to system prompt for caching)",
				!prompt.includes(
					"CRITICAL INSTRUCTIONS FOR CHRONOLOGICAL RECONCILIATION",
				) &&
					!prompt.includes("STRICT MONOTONIC TASK RECONCILIATION") &&
					!prompt.includes("3-TIER EPISTEMIC CLASSIFICATION"),
				{ promptExcerpt: prompt.slice(0, 200) },
			);
			assertPass(
				"User message preserves the varying data (custom instructions)",
				prompt.includes("Preserve all error codes"),
				{ prompt },
			);
			logPass(
				"Chronological prompt topology verified (static instructions moved to system prompt)!",
			);
		},
	);
}

main().catch((err) => {
	console.error(err);
	throw err;
});
