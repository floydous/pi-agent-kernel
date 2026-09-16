import * as os from "node:os";
import * as path from "node:path";
import { renderFooter, stripAnsi } from "../../src/ui/footer";
import { assertPass, logPass } from "../_setup";

export function testUnifiedFooter(): void {
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
	const strippedMainLine = stripAnsi(mainFooterLine);
	assertPass("Unified footer format includes CWD and branch", strippedMainLine.includes("~/.pi/agent/extensions (main)"), { mainFooterLine });
	assertPass("Unified footer includes context usage", strippedMainLine.includes("13k/128k") && strippedMainLine.includes("10%"), { mainFooterLine });
	assertPass("Unified footer includes token counts and cost", strippedMainLine.includes("↑1.3k") && strippedMainLine.includes("↓450") && strippedMainLine.includes("$0.002"), { mainFooterLine });
	assertPass("Unified footer includes provider and model", strippedMainLine.includes("(openai)") && strippedMainLine.includes("gpt-4o-mini"), { mainFooterLine });
	assertPass("Unified footer contains 24-bit TrueColor ANSI codes", mainFooterLine.includes("\x1b[38;2;"), { mainFooterLine: mainFooterLine.slice(0, 200) });

	const extensionLine = renderedLines[1];
	const strippedExtLine = stripAnsi(extensionLine || "");
	assertPass("Extension status line includes retrieval profile", strippedExtLine.includes("retrieval:hybrid"), { renderedLines });
	assertPass("Extension status line includes other extensions", strippedExtLine.includes("ready"), { renderedLines });

	logPass(`Unified integrated pastel footer rendering verified!`);
}
