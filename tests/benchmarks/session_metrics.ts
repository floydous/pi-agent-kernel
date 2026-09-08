import * as fs from "node:fs";

export interface SessionMetrics {
	toolCalls: Record<string, number>;
	toolOutputChars: Record<string, number>;
	codeSearchModes: string[];
	markdownResultLines: number;
	totalOutputChars: number;
}

export function measureSession(filePath: string): SessionMetrics {
	const metrics: SessionMetrics = {
		toolCalls: {},
		toolOutputChars: {},
		codeSearchModes: [],
		markdownResultLines: 0,
		totalOutputChars: 0,
	};

	for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const event = JSON.parse(line);
		if (event.type !== "message") continue;
		const message = event.message ?? {};
		const content = Array.isArray(message.content) ? message.content : [];
		for (const block of content) {
			if (block?.type === "toolCall") {
				const name = String(block.name ?? "unknown");
				metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;
			}
			if (message.role === "toolResult" && block?.type === "text") {
				const name = String(message.toolName ?? "unknown");
				const text = String(block.text ?? "");
				metrics.toolOutputChars[name] = (metrics.toolOutputChars[name] ?? 0) + text.length;
				metrics.totalOutputChars += text.length;
				if (name === "code_search") {
					const header = text.split("\n", 1)[0] ?? "";
					if (header.startsWith("[code_search")) metrics.codeSearchModes.push(header);
					metrics.markdownResultLines += text
						.split("\n")
						.filter((resultLine: string) => /(?:\.md|\.mdx|\.txt|\.rst):\d/.test(resultLine))
						.length;
				}
			}
		}
	}
	return metrics;
}
