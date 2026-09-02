// Recall Tool
// Dereferences a [=rN,sizeB,tool,paramsKey] dedup notice back to the full
// original tool-result text. No preamble, no formatting — bare bytes only.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, makeOutputText } from "../ui/tui_utils";
import type { DedupStore } from "./content_store";
import type { SessionDeps } from "../tools/context";

export interface RecallDeps extends SessionDeps {
	getDedupStore: () => DedupStore;
}

export interface RecallEntry {
	fullText: string;
	sizeBytes: number;
	toolName: string;
	paramsKey: string;
}

/**
 * Pure decision logic. Extracted from the tool so it can be unit-tested
 * without the Pi extension harness.
 *
 * Returns one of:
 *  - { kind: "ok", fullText, sizeBytes, toolName, paramsKey }
 *  - { kind: "error", message }  (validation failure or unknown ref)
 */
export function decideRecall(
	ref: unknown,
	store: {
		get: (sessionId: string, ref: string) => RecallEntry | null;
	},
	sessionId: string,
):
	| { kind: "ok"; fullText: string; sizeBytes: number; toolName: string; paramsKey: string }
	| { kind: "error"; message: string } {
	const refStr = typeof ref === "string" ? ref.trim() : "";
	if (!refStr) {
		return { kind: "error", message: "[recall] ref is required (e.g. 'r1')." };
	}
	if (!/^r\d+$/.test(refStr)) {
		return {
			kind: "error",
			message: `[recall] invalid ref '${refStr}'; expected format 'rN' where N is a positive integer.`,
		};
	}
	const got = store.get(sessionId, refStr);
	if (got === null) {
		return {
			kind: "error",
			message: `[recall] no content stored at ref '${refStr}' in this session.`,
		};
	}
	return {
		kind: "ok",
		fullText: got.fullText,
		sizeBytes: got.sizeBytes,
		toolName: got.toolName,
		paramsKey: got.paramsKey,
	};
}

/** Extracted pattern: registers the `recall` tool. */
export function registerRecallTool(pi: ExtensionAPI, deps: RecallDeps): void {
	pi.registerTool({
		name: "recall",
		label: "Recall Dedup'd Result",
		description:
			"Retrieve the full text of a tool result that was replaced by a dedup reference like [=rN,sizeB,tool,paramsKey]. The `ref` is the rN identifier from a prior tool result. Returns the bare original text and the tool name and paramsKey so the caller can decide what to do next.",
		promptSnippet:
			"Recover the full text of a tool result that was dedup'd, by its rN reference",
		renderShell: "default",
		parameters: Type.Object({
			ref: Type.String({
				description:
					"The reference identifier, e.g. 'r1', 'r2'. Comes from a [=rN,sizeB,tool,paramsKey] dedup notice in a prior tool result.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			ctx: any,
		): Promise<any> {
			const ref = (params?.ref || "").trim();
			if (!ref) {
				return {
					content: [
						{ type: "text", text: "[recall] ref is required (e.g. 'r1')." },
					],
					isError: true,
				};
			}
			if (!/^r\d+$/.test(ref)) {
				return {
					content: [
						{
							type: "text",
							text: `[recall] invalid ref '${ref}'; expected format 'rN' where N is a positive integer.`,
						},
					],
					isError: true,
				};
			}

			const sessionId = deps.getSessionId(ctx);
			const store = deps.getDedupStore();
			const got = store.get(sessionId, ref);
			if (got === null) {
				return {
					content: [
						{
							type: "text",
							text: `[recall] no content stored at ref '${ref}' in this session.`,
						},
					],
					isError: true,
				};
			}

			// Bare text. No preamble, no formatting. The LLM knows what rN is.
			// Include toolName and paramsKey in the `details` so the host
			// TUI can show provenance but the LLM-context output stays bare.
			return {
				content: [{ type: "text", text: got.fullText }],
				details: {
					ref,
					sizeBytes: got.sizeBytes,
					toolName: got.toolName,
					paramsKey: got.paramsKey,
				},
			};
		},
		renderCall(args: any, theme: any, _context: any) {
			return makeOutputText(
				`${theme.fg("toolTitle", theme.bold("recall"))} ${theme.fg("accent", args?.ref || "")}`,
			);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (context.isError) {
				const errMsg =
					result.content?.find((c: any) => c.type === "text")?.text ||
					"Recall failed";
				return makeOutputText(`\n${theme.fg("error", errMsg)}`);
			}
			if (!options.expanded) {
				return new Text("", 0, 0);
			}
			const output =
				result.content?.find((c: any) => c.type === "text")?.text || "";
			return makeOutputText(`\n${theme.fg("toolOutput", output)}`);
		},
	});
}
