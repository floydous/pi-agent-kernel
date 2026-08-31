import * as child_process from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractFileTags } from "../retrieval/repomap";
import { kernelDebug } from "../safety/kernel_debug";

export const ENHANCED_SUMMARIZATION_PROMPT = `The messages and workspace state above represent an evolving agent trajectory. Create a structured context checkpoint summary that another LLM will use to continue the work seamlessly.

CRITICAL INSTRUCTIONS FOR CHRONOLOGICAL RECONCILIATION & EPISTEMIC GROUNDING:
1. STRICT MONOTONIC TASK RECONCILIATION:
   - Examine <historical-summary-baseline>. If a task was previously marked "[ ] In Progress", cross-reference it with <recent-turn-actions-digest> and <workspace-state>.
   - If the code was written or tests passed (exit code 0), you MUST move the task to "### Done" with "[x]".
   - "### In Progress / Blocked" MUST ONLY contain active tasks that remain unfinished at the true end of the trajectory. If all work was completed, state "- (None - ready for user instructions)".
2. EPISTEMIC COMPRESSION:
   - Use section headings as status labels; do not repeat [VERIFIED], [ASSERTED], or [AMBIGUOUS] on every bullet.
   - Put proven facts under "Verified Facts & State".
   - Put user/model claims that are not tool-verified under "User-Reported / Unverified".
   - Put unresolved questions, conflicting requirements, and blockers under "Open Ambiguities & Unresolved Blockers".
   - Use an inline status marker only when a single bullet contains mixed-status claims.
3. PRESERVE [WHY-NOT & FAILED ATTEMPTS]: Record why certain approaches failed so the agent never enters a retry loop.
4. PRESERVE NEGATIVE CONSTRAINTS & USER PROHIBITIONS VERBATIM.

Structure your response using these exact Markdown sections:

## Goal
The active objective of the session.

## FORBIDDEN / Negative Constraints (CRITICAL - DO NOT DROP)
Enumerate every negative constraint, explicit user prohibition, frozen file/module, or safety restriction (e.g. "DO NOT modify legacy_auth.py", "NEVER use sudo", "Preserve existing API signatures").

## Verified Facts & State (Backed by Real Tool Outputs / Exit Codes)
Enumerate key ground truths established by real tool executions:
- Include only facts proven by tool execution, command output, or disk state.
- Specific compiler errors, test results, or exit codes encountered.
- Absolute paths, ports, or IDs verified to exist.

## User-Reported / Unverified
- Include user or model claims that matter to continuation but were not established by tool execution, or "(None)".

## Open Ambiguities & Unresolved Blockers
- List open questions, conflicting requirements, or unresolved blockers, or "(None - all current requirements verified)".

## Progress (Evaluated at the True End of Conversation)
### Done
- [x] [List all tasks and changes that were completed and verified by the end of conversation]

### In Progress / Blocked
- [ ] [Current active work ONLY if truly unfinished. If none, write: (None - ready for user instructions)]

## Key Decisions, Epistemic Reasoning & Why-Not Records
- Key architectural choices or trade-offs made.
- **Why-Not & Abandoned Paths**: Why certain approaches failed or were rejected (prevents repetition loops).

## Next Steps
1. The immediate next action to take (if all previous tasks are Done, state "Ready for user instructions" or the next logical step).
2. Subsequent steps in chronological order.

Keep the summary dense, grounded, and actionable. Do NOT lose critical negative constraints or verified errors.`;

export function extractWorkspaceState(cwd: string): string {
	try {
		// Keep Git subprocess output captured so warnings do not leak into the TUI.
		const commonOpts = {
			cwd,
			encoding: "utf8" as const,
			timeout: 5000,
			stdio: "pipe" as const,
		};
		const gitStatus = child_process
			.execFileSync("git", ["status", "-s"], commonOpts)
			.toString()
			.trim();
		const gitLog = child_process
			.execFileSync("git", ["log", "-n", "5", "--oneline"], commonOpts)
			.toString()
			.trim();
		const gitDiffStat = child_process
			.execFileSync("git", ["diff", "--stat"], commonOpts)
			.toString()
			.trim();

		let out = `<workspace-state>\n[Status]:\n${gitStatus || "clean (workspace clean)"}`;
		if (gitLog) out += `\n\n[Recent Entries]:\n${gitLog}`;
		if (gitDiffStat) out += `\n\n[Uncommitted Changes]:\n${gitDiffStat}`;
		out += `\n</workspace-state>`;
		return out;
	} catch {
		return "";
	}
}

export function extractModifiedFilesAstSummary(
	cwd: string,
	modifiedFiles: string[],
): string {
	if (!modifiedFiles || modifiedFiles.length === 0) return "";
	const lines: string[] = ["<modified-files-ast>"];

	for (const relPath of modifiedFiles.slice(0, 10)) {
		try {
			const absPath = path.isAbsolute(relPath)
				? relPath
				: path.resolve(cwd, relPath);
			if (fs.existsSync(absPath)) {
				const content = fs.readFileSync(absPath, "utf8");
				const tags = extractFileTags(absPath, content);
				if (tags.definitions.length > 0) {
					lines.push(`\n${relPath}:`);
					for (const def of tags.definitions.slice(0, 15)) {
						lines.push(`  │ ${def.signature}`);
					}
				}
			}
		} catch (e) {
			kernelDebug(e);
		}
	}
	lines.push("</modified-files-ast>");
	return lines.length > 2 ? lines.join("\n") : "";
}

/**
 * Extracts a high-density, token-efficient digest of tool executions,
 * exit codes, and user requests across the recent trajectory entries.
 */
export function extractTrajectoryDigest(
	branchEntries: any[],
	maxEntries = 40,
): string {
	if (!branchEntries || branchEntries.length === 0) return "";

	const recent = branchEntries.slice(-maxEntries);
	const events: string[] = [];

	for (const entry of recent) {
		if (!entry) continue;

		if (entry.type === "message" && entry.message) {
			const msg = entry.message;
			if (msg.role === "user") {
				const text = Array.isArray(msg.content)
					? msg.content
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join(" ")
					: typeof msg.content === "string"
						? msg.content
						: "";
				const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
				if (snippet) events.push(`[User Prompt]: "${snippet}"`);
			} else if (msg.role === "assistant") {
				if (Array.isArray(msg.content)) {
					for (const c of msg.content) {
						if (c.type === "toolCall" || c.type === "tool_call" || c.toolName) {
							const name = c.toolName || c.name || "tool";
							const args = c.args ? JSON.stringify(c.args).slice(0, 100) : "";
							events.push(`[Assistant Call]: ${name}(${args})`);
						}
					}
				}
			} else if (msg.role === "toolResult" || msg.role === "tool") {
				const toolName = msg.toolName || "tool";
				const isErr = msg.isError ? "FAILED" : "SUCCESS";
				let preview = "";
				if (Array.isArray(msg.content)) {
					const txt = msg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join(" ");
					preview = txt.replace(/\s+/g, " ").trim().slice(0, 100);
				}
				events.push(
					`[Tool Result ${toolName}]: ${isErr} ${preview ? `-> ${preview}` : ""}`,
				);
			}
		}
	}

	if (events.length === 0) return "";
	return `<recent-turn-actions-digest>\n${events.join("\n")}\n</recent-turn-actions-digest>`;
}

export function buildChronologicalCompactionPrompt(options: {
	previousSummary?: string;
	discardedConversationText: string;
	recentTrajectoryDigest?: string;
			workspaceState?: string;
	customInstructions?: string;
}): string {
	let prompt = "";

	// 1. Historical Baseline (Time t0)
	if (options.previousSummary) {
		prompt += `<historical-summary-baseline>\n${options.previousSummary}\n</historical-summary-baseline>\n\n`;
	}

	// 2. Discarded Messages History (Time t0 -> t1)
	prompt += `<discarded-conversation-history>\n${options.discardedConversationText}\n</discarded-conversation-history>\n\n`;

	// 3. Recent Trajectory Actions Digest (Time t1 -> t2, from kept turns)
	if (options.recentTrajectoryDigest) {
		prompt += `${options.recentTrajectoryDigest}\n\n`;
	}

	// 4. Deterministic workspace state
			if (options.workspaceState) {
				prompt += `${options.workspaceState}\n\n`;
			}

	// Note: The static summarization instructions (`ENHANCED_SUMMARIZATION_PROMPT`)
	// are intentionally NOT included in the user message. They live in the system
	// prompt now so that providers' prompt caches can reuse them across compactions.
	// `buildCompactionSystemPrompt` below composes the full system prompt.

	if (options.customInstructions) {
		prompt += `\n\nAdditional focus: ${options.customInstructions}`;
	}

	return prompt;
}

/**
 * Build the system prompt for a compaction call. Concatenates the generic
 * summarization-assistant role with the static `ENHANCED_SUMMARIZATION_PROMPT`
 * so that providers' prompt caches can reuse the static portion across calls.
 *
 * The user message built by `buildChronologicalCompactionPrompt` contains only
 * varying data (conversation, git state, trajectory digest). The system prompt
 * here is the stable, cacheable half.
 */
export function buildCompactionSystemPrompt(): string {
	return (
		"You are a context summarization assistant. Produce the structured summary following the exact format specified. Reconcile all tasks against workspace state and recent tool outputs. Do NOT continue the conversation.\n\n" +
		ENHANCED_SUMMARIZATION_PROMPT
	);
}

/**
 * Serialize Agent messages to text for summarization without external module dependency.
 */
export function serializeAgentMessages(messages: any[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (!msg) continue;
		if (msg.role === "user") {
			let text = "";
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content)) {
				text = msg.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
			}
			if (text.trim()) parts.push(`[User]: ${text.trim()}`);
		} else if (msg.role === "assistant") {
			let text = "";
			const toolCalls: string[] = [];
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "text" && block.text) text += block.text + "\n";
					else if (
						block.type === "toolCall" ||
						block.type === "tool_call" ||
						block.name
					) {
						const name = block.name || block.toolName || "tool";
						const args = block.arguments || block.args || {};
						const argsStr = Object.entries(args)
							.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
							.join(", ");
						toolCalls.push(`${name}(${argsStr})`);
					}
				}
			}
			if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`);
			if (toolCalls.length > 0)
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
		} else if (msg.role === "toolResult" || msg.role === "tool") {
			let text = "";
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content)) {
				text = msg.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
			}
			const maxChars = 2000;
			const truncated =
				text.length > maxChars
					? `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
					: text;
			if (truncated.trim())
				parts.push(
					`[Tool result (${msg.toolName || "tool"})]: ${truncated.trim()}`,
				);
		}
	}
	return parts.join("\n\n");
}

export function registerCustomCompaction(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		try {
			const preparation = event.preparation;
			const branchEntries = event.branchEntries || [];
			const customInstructions = event.customInstructions;
			const signal = event.signal;

			if (!preparation) return undefined;

			// Extract all messages to summarize (including turnPrefixMessages for split turns)
			const messagesToSummarize = [
				...(preparation.messagesToSummarize || []),
				...(preparation.turnPrefixMessages || []),
			];
			if (messagesToSummarize.length === 0) {
				return undefined;
			}

			// Format conversation history accurately
			let conversationText = serializeAgentMessages(messagesToSummarize);

			// Extract deterministic workspace state
			const workspaceDir = ctx.cwd || process.cwd();
			const workspaceState = extractWorkspaceState(workspaceDir);
			const recentTrajectoryDigest = extractTrajectoryDigest(branchEntries, 40);

			// Build strictly chronological, grounded prompt.
			// Note: the static `ENHANCED_SUMMARIZATION_PROMPT` is NOT included here
			// — it lives in the system prompt (see `buildCompactionSystemPrompt`).
			// This partitioning lets the provider's prompt cache reuse the static
			// portion across compaction calls within the same session.
			// `promptText` is `let` (not `const`) because the retry path rebuilds
			// it with a truncated conversation if the first model call returns
			// empty content. See the retry block at the bottom of this handler.
			let promptText = buildChronologicalCompactionPrompt({
				previousSummary: preparation.previousSummary,
				discardedConversationText: conversationText,
				recentTrajectoryDigest,
				workspaceState,
				customInstructions,
			});

			// Resolve model via modelRegistry / context model
			const model = ctx.model;
			const modelRegistry = ctx.modelRegistry;

			// Stable session id for the provider's prompt cache. Without this,
			// the provider may treat each compaction as an unrelated call and
			// never hit the cache. Falls back to undefined (caller's choice)
			// when the session id cannot be determined.
			const sessionId =
				(ctx as any)?.sessionManager?.getSessionId?.() ?? undefined;

			let summaryText = "";
			let responseUsage: any;
			// Captured raw response for diagnostic logging when the summary ends up empty.
			// Set by both the modelRegistry path and the fallback HTTP path.
			let lastRawResponse: string | undefined;

			if (modelRegistry && model) {
				const summaryMessages = [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: promptText }],
						timestamp: Date.now(),
					},
				];

				const response = await modelRegistry.complete(
					model,
					{
						systemPrompt: buildCompactionSystemPrompt(),
						messages: summaryMessages,
					},
					{
						maxTokens: 8192,
						temperature: 0.1,
						signal,
						// "short" enables prompt caching for providers that support it
						// (Anthropic, OpenAI modern APIs, Google, etc.). For providers
						// that don't support caching, this option is ignored.
						// Previously this was "none", which explicitly disabled caching.
						cacheRetention: "short",
						// Stable across compactions within the same pi session so the
						// provider can recognize the same logical session and apply
						// its cache. (Previously this was omitted, leaving the
						// provider to invent its own session id per call.)
						sessionId,
						// Cap reasoning at "low" for compaction calls. The
						// MiniMax-M3 model uses Sparse Attention + reasoning tokens,
						// and the docs warn: "A reasoning-heavy turn can consume
						// the whole response and emit no answer." If reasoning eats
						// the entire `maxTokens` budget, `finishReason: "length"`
						// comes back with `contentLen: 0` and the summary is empty.
						// Reasoning is required (per the model docs) for the
						// summarization to work, but at a controlled level it
						// leaves room for the visible output. "low" gives the
						// model enough thinking to plan the summary without
						// starving the output.
						reasoning: "low",
					},
				);

				summaryText = response.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
				responseUsage = response.usage;
				// Capture for diagnostic logging on empty summary.
				// Includes the full response shape so we can see what the
				// modelRegistry actually returned — not just the fields we
				// think are useful. If the model returns content in an
				// unexpected field (e.g., `text` instead of `content[].text`),
				// this will surface it. Truncated to 1000 chars to avoid
				// log bloat.
				try {
					lastRawResponse = JSON.stringify({
						contentLen: summaryText.length,
						finishReason:
							(response as any).stopReason ?? (response as any).finish_reason ?? null,
						usage: response.usage ?? null,
						contentBlockTypes: Array.isArray(response.content)
							? response.content.map((c: any) => c.type)
							: [],
						contentBlockCount: Array.isArray(response.content)
							? response.content.length
							: 0,
						// Full response shape (truncated for log size)
						responseShape: Object.keys(response ?? {}),
						responseSample: JSON.stringify(response).slice(0, 1000),
					});
				} catch (e) {
					kernelDebug(e);
				}
			} else {
				// Fallback to direct HTTP completions if running in headless test/detached harness
				const baseUrl =
					(model as any)?.baseUrl ||
					process.env.CUSTOM_LLM_BASE_URL ||
					process.env.OPENAI_BASE_URL ||
					"http://localhost:11434/v1";
				const modelId = model?.id || "Hermes-Fast";
				const apiKey =
					(model as any)?.apiKey || process.env.OPENAI_API_KEY || "local";

				const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({
						model: modelId,
						messages: [
							{
								role: "system",
								content: buildCompactionSystemPrompt(),
							},
							{
								role: "user",
								content: promptText,
							},
						],
						stream: false,
						temperature: 0.1,
						max_tokens: 4096,
					}),
					signal,
				});

				if (!res.ok) {
					throw new Error(
						`LLM summarization failed with HTTP ${res.status}: ${await res.text()}`,
					);
				}

				const textResponse = await res.text();
				// Capture the raw response before parsing, so we can log it on empty-summary.
				lastRawResponse = textResponse;
				try {
					const data = JSON.parse(textResponse);
					summaryText = data?.choices?.[0]?.message?.content || "";
					responseUsage = data?.usage;
				} catch {
					// Support SSE stream format from gateway if returned
					const lines = textResponse.split("\n");
					for (const line of lines) {
						const trimmed = line.trim();
						if (trimmed.startsWith("data:") && !trimmed.includes("[DONE]")) {
							try {
								const data = JSON.parse(trimmed.slice(5).trim());
								const delta =
									data?.choices?.[0]?.delta?.content ||
									data?.choices?.[0]?.message?.content ||
									"";
								summaryText += delta;
								if (data?.usage) responseUsage = data.usage;
							} catch (e) {
								kernelDebug(e);
							}
						}
					}
				}
			}

			if (!summaryText.trim()) {
				// Empty summary. Two distinct cases observed in the wild:
				//   (a) finishReason: "length" with contentLen: 0 — model hit
				//       max_tokens with 0 tokens of output. The input prompt is
				//       likely too large for the model's effective context window
				//       (especially on free-tier / non-standard providers).
				//   (b) Content-filter refusal or transient model failure.
				//
				// For (a), retry with a truncated conversation. For (b), the
				// diagnostic gives us enough signal to investigate next time.
				const lastResponse = lastRawResponse;
				const finishReason = (() => {
					try {
						const parsed = lastResponse ? JSON.parse(lastResponse) : null;
						return parsed?.finishReason ?? null;
					} catch {
						return null;
					}
				})();

				// If the prompt is over 32K chars, try one retry with the most
				// recent half of the conversation. Otherwise log and throw.
				const PROMPT_TOO_LARGE = 32_000;
				if (conversationText.length > PROMPT_TOO_LARGE) {
					console.error(
						`[EnhancedCompaction] Empty summary on large input (conversationText=${conversationText.length} chars, finishReason=${finishReason}). Retrying with truncated input.`,
					);
					// Truncate: keep the most recent half of the conversation
					// (the older half is less informative for a forward-looking
					// summary anyway).
					const half = Math.floor(messagesToSummarize.length / 2);
					const truncatedMessages = messagesToSummarize.slice(half);
					conversationText = serializeAgentMessages(truncatedMessages);
					promptText = buildChronologicalCompactionPrompt({
						previousSummary: preparation.previousSummary,
						discardedConversationText: conversationText,
						recentTrajectoryDigest,
						workspaceState,
						customInstructions,
					});
					// Reset state for retry
					summaryText = "";
					responseUsage = undefined;
					lastRawResponse = undefined;
					// Retry the model call once. The retry shares the same
					// modelRegistry / fallback HTTP dispatch as the first call.
					if (modelRegistry && model) {
						const summaryMessages2 = [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: promptText }],
								timestamp: Date.now(),
							},
						];
						try {
							const response2 = await modelRegistry.complete(
								model,
								{
									systemPrompt: buildCompactionSystemPrompt(),
									messages: summaryMessages2,
								},
								{
									maxTokens: 8192,
									temperature: 0.1,
									signal,
									cacheRetention: "short",
									sessionId,
									// Match the first call: cap reasoning at "low" so
									// it doesn't consume the entire output budget.
									reasoning: "low",
								},
							);
							summaryText = response2.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n");
							responseUsage = response2.usage;
							try {
								lastRawResponse = JSON.stringify({
									contentLen: summaryText.length,
									finishReason:
										(response2 as any).stopReason ??
										(response2 as any).finish_reason ??
										null,
									usage: response2.usage ?? null,
									contentBlockTypes: Array.isArray(response2.content)
										? response2.content.map((c: any) => c.type)
										: [],
									contentBlockCount: Array.isArray(response2.content)
										? response2.content.length
										: 0,
									retried: true,
								});
							} catch (e) {
								kernelDebug(e);
							}
						} catch (e) {
							// Retry failed; fall through to the final error below.
							console.error(
								"[EnhancedCompaction] Retry also failed:",
								(e as Error).message,
							);
						}
					} else {
						// HTTP fallback retry
						const baseUrl2 =
							(model as any)?.baseUrl ||
							process.env.CUSTOM_LLM_BASE_URL ||
							process.env.OPENAI_BASE_URL ||
							"http://localhost:11434/v1";
						const modelId2 = model?.id || "Hermes-Fast";
						const apiKey2 =
							(model as any)?.apiKey || process.env.OPENAI_API_KEY || "local";
						try {
							const res2 = await fetch(
								`${baseUrl2.replace(/\/+$/, "")}/chat/completions`,
								{
									method: "POST",
									headers: {
										"Content-Type": "application/json",
										Authorization: `Bearer ${apiKey2}`,
									},
									body: JSON.stringify({
										model: modelId2,
										messages: [
											{ role: "system", content: buildCompactionSystemPrompt() },
											{ role: "user", content: promptText },
										],
										stream: false,
										temperature: 0.1,
										max_tokens: 4096,
									}),
									signal,
								},
							);
							if (res2.ok) {
								const textResponse2 = await res2.text();
								lastRawResponse = textResponse2;
								try {
									const data = JSON.parse(textResponse2);
									summaryText = data?.choices?.[0]?.message?.content || "";
									responseUsage = data?.usage;
								} catch {
									const lines = textResponse2.split("\n");
									for (const line of lines) {
										const trimmed = line.trim();
										if (trimmed.startsWith("data:") && !trimmed.includes("[DONE]")) {
											try {
												const data = JSON.parse(trimmed.slice(5).trim());
												const delta =
													data?.choices?.[0]?.delta?.content ||
													data?.choices?.[0]?.message?.content ||
													"";
												summaryText += delta;
											} catch (e) {
												kernelDebug(e);
											}
										}
									}
								}
							}
						} catch (e) {
							console.error(
								"[EnhancedCompaction] HTTP retry also failed:",
								(e as Error).message,
							);
						}
					}
				} else {
					console.error(
						`[EnhancedCompaction] Empty summary on small input (conversationText=${conversationText.length} chars, finishReason=${finishReason}). No retry — input is small. Diagnostic below.`,
					);
				}

				// Final check after retry (or no-retry) attempt.
				if (!summaryText.trim()) {
					console.error(
						"[EnhancedCompaction] Empty summary. responseLen=",
						typeof lastRawResponse === "string" ? lastRawResponse.length : "n/a",
						" preview=",
						typeof lastRawResponse === "string"
							? lastRawResponse.slice(0, 200)
							: "n/a",
					);
					throw new Error("Compaction produced empty summary text.");
				}
			}

			// Append deterministic Git workspace state
			if (workspaceState) {
				summaryText += `\n\n${workspaceState}`;
			}

			// Compute read/modified files
			let readFiles: string[] = [];
			let modifiedFiles: string[] = [];
			if (preparation.fileOps) {
				const edited = preparation.fileOps.edited || new Set();
				const written = preparation.fileOps.written || new Set();
				const read = preparation.fileOps.read || new Set();
				const modified = new Set([...edited, ...written]);
				readFiles = (Array.from(read) as string[]).filter(
					(f: string) => !modified.has(f),
				);
				modifiedFiles = Array.from(modified) as string[];
			}

			if (readFiles.length > 0) {
				summaryText += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
			}
			if (modifiedFiles.length > 0) {
				summaryText += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
				const astSummary = extractModifiedFilesAstSummary(
					workspaceDir,
					modifiedFiles,
				);
				if (astSummary) {
					summaryText += `\n\n${astSummary}`;
				}
			}

			// Normalize usage shape with safe cost object
			const inputTokens =
				responseUsage?.prompt_tokens ?? responseUsage?.input ?? 0;
			const outputTokens =
				responseUsage?.completion_tokens ?? responseUsage?.output ?? 0;
			const cacheRead =
				responseUsage?.prompt_tokens_details?.cached_tokens ??
				responseUsage?.cacheRead ??
				0;
			const cacheWrite = responseUsage?.cacheWrite ?? 0;
			const totalTokens =
				responseUsage?.total_tokens ??
				responseUsage?.totalTokens ??
				inputTokens + outputTokens;

			const usage = {
				input: inputTokens,
				output: outputTokens,
				cacheRead,
				cacheWrite,
				totalTokens,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			};

			return {
				compaction: {
					summary: summaryText,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			console.error(
				"[EnhancedCompaction] Fallback to default compaction due to:",
				error,
			);
			return undefined;
		}
	});
}
