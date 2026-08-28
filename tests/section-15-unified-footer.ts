// Section 15: Unified Footer Formatting & Layout
// Tests renderFooter produces a properly formatted line with TrueColor codes.

import * as os from "node:os";
import * as path from "node:path";
import { renderFooter, stripAnsi } from "../src/ui/footer";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("15. Unified Footer Formatting & Layout", () => {
		// Mock context and footer data
		const mockHome = os.homedir();
		const mockCwd = path.join(mockHome, ".pi", "agent", "extensions");
		const mockCtx = {
			cwd: mockCwd,
			sessionManager: {
				getCwd: () => mockCwd,
				getEntries: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 1250, output: 450, cost: { total: 0.0023 } },
						},
					},
				],
			},
			model: { id: "gpt-4o-mini", provider: "openai", contextWindow: 128000, reasoning: false },
			getContextUsage: () => ({ tokens: 12500, contextWindow: 128000, percent: 9.76 }),
			thinkingLevel: "off",
		};

		const mockFooterData = {
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([["test-ext", "ready"]]),
			getAvailableProviderCount: () => 2,
			onBranchChange: (_fn: any) => () => {},
		};

		const mockTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};

		const mockSearchIndex = {
			getEffectiveProfile: () => "hybrid",
			getProfile: () => "auto",
		};

		const renderedLines = renderFooter(mockCtx, mockTheme, mockFooterData, 140, mockSearchIndex);
		assertPass("Footer rendered non-empty lines", renderedLines && renderedLines.length > 0, { renderedLines });

		const mainFooterLine = renderedLines[0];
		const strippedLine = stripAnsi(mainFooterLine);
		assertPass(
			"Unified footer format matches expected layout",
			strippedLine.includes("~/.pi/agent/extensions (main)") &&
				strippedLine.includes("retrieval:hybrid-256d") &&
				strippedLine.includes("13k/128k (10%)") &&
				strippedLine.includes("↑1.3k ↓450 $0.002") &&
				strippedLine.includes("(openai) gpt-4o-mini"),
			{ mainFooterLine }
		);

		// Verify that semantic 24-bit TrueColor ANSI codes are present
		assertPass(
			"Unified footer contains 24-bit TrueColor ANSI codes",
			mainFooterLine.includes("\x1b[38;2;"),
			{ mainFooterLine: mainFooterLine.slice(0, 200) }
		);
		logPass(`Unified integrated pastel footer rendering verified: ${strippedLine}`);
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
