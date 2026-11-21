/**
 * Zero-Dependency TUI Helper Utilities
 * Works across standalone test suites and live Pi TUI environments.
 */

export interface Focusable {
	focused: boolean;
	handleInput?(data: string): Promise<void> | void;
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
}

export const ANSI_REGEX =
	/(?:\x1B\][^\x07\x1B]*(?:\x07|\x1B\\|\x9C))|(?:\x1B\[[0-9;?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
	if (!text) return "";
	if (!text.includes("\x1b")) return text;
	return text.replace(ANSI_REGEX, "");
}

export function visibleWidth(text: string): number {
	if (!text) return 0;
	if (!text.includes("\x1b")) return text.length;
	return stripAnsi(text).length;
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis = "...",
): string {
	maxWidth = Math.max(0, Math.floor(maxWidth));
	const vis = visibleWidth(text);
	if (vis <= maxWidth) return text;
	const ellVis = visibleWidth(ellipsis);
	if (maxWidth <= ellVis) return ellipsis.slice(0, maxWidth);

	const raw = stripAnsi(text);
	return raw.slice(0, maxWidth - ellVis) + ellipsis;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	width = Math.max(1, Math.floor(width));
	if (!text) return [""];
	const inputLines = text.split(/\r\n|\r|\n/);
	const result: string[] = [];

	for (const inputLine of inputLines) {
		if (visibleWidth(inputLine) <= width) {
			result.push(inputLine);
			continue;
		}

		if (!inputLine.includes("\x1b")) {
			for (let i = 0; i < inputLine.length; i += width) {
				result.push(inputLine.slice(i, i + width));
			}
			continue;
		}

		// Tokenize into words and ansi escapes
		const tokens: string[] = [];
		let currentToken = "";
		let inWhitespace = false;
		let i = 0;

		while (i < inputLine.length) {
			ANSI_REGEX.lastIndex = i;
			const match = ANSI_REGEX.exec(inputLine);
			if (match && match.index === i) {
				currentToken += match[0];
				i += match[0].length;
				continue;
			}

			const char = inputLine[i];
			const isWs = /\s/.test(char);
			if (
				currentToken.length > 0 &&
				isWs !== inWhitespace &&
				!currentToken.endsWith("\x1b")
			) {
				tokens.push(currentToken);
				currentToken = "";
			}
			inWhitespace = isWs;
			currentToken += char;
			i++;
		}
		if (currentToken.length > 0) tokens.push(currentToken);

		let curLine = "";
		let curWidth = 0;

		for (const token of tokens) {
			const tokenWidth = visibleWidth(token);
			if (tokenWidth === 0) {
				curLine += token;
				continue;
			}

			if (curWidth + tokenWidth <= width) {
				curLine += token;
				curWidth += tokenWidth;
			} else {
				if (tokenWidth > width) {
					// Break excessively long token character by character
					let j = 0;
					while (j < token.length) {
						ANSI_REGEX.lastIndex = j;
						const m = ANSI_REGEX.exec(token);
						if (m && m.index === j) {
							curLine += m[0];
							j += m[0].length;
							continue;
						}
						const ch = token[j];
						if (curWidth + 1 > width) {
							if (curLine) result.push(curLine);
							curLine = ch;
							curWidth = 1;
						} else {
							curLine += ch;
							curWidth += 1;
						}
						j++;
					}
				} else {
					if (curLine) result.push(curLine);
					curLine = token;
					curWidth = tokenWidth;
				}
			}
		}
		if (curLine) result.push(curLine);
	}

	return result.length > 0 ? result : [""];
}

/**
 * Get a safe per-line width for tool output rendering.
 *
 * The pi runtime does not pass the terminal width to a tool's `renderResult`.
 * We read `process.stdout.columns` (the Node TTY width, shared with pi's
 * `terminal.columns` in the same process) and subtract a safety margin for
 * the parent Box's `paddingX=1` on each side plus a small additional buffer.
 *
 * If `process.stdout.columns` is undefined (non-TTY: pipes, redirects,
 * `--print` mode, RPC mode without a TTY), fall back to 200 columns, which
 * is narrower than typical interactive terminals but always fits the parent
 * Box's wrap.
 *
 * The safety margin is conservative (4 columns) so a downstream renderer
 * that adds an additional paddingX layer or a border will not overflow.
 */
export function getSafeLineWidth(): number {
	const cols = process.stdout.columns;
	const base = typeof cols === "number" && cols > 0 ? cols : 200;
	return Math.max(40, base - 4);
}

/**
 * Build a `Text` component suitable for use in a tool's `renderCall` or
 * `renderResult` that is guaranteed not to render a line wider than the
 * terminal, regardless of the parent's `paddingX`.
 *
 * Why a fresh `Text` instead of reusing `context.lastComponent`:
 * The previous implementation did `context.lastComponent ?? new Text("", 0, 0)`
 * and called `setText` on it. The returned component then became a child of
 * pi's `contentBox` (a `Box` with `paddingX=1`). When the runtime passed
 * back a `lastComponent` that already had `paddingX=1` (pi's `contentText`
 * default), the child Text's own `render(width)` reserved `paddingX*2` of
 * width on top of the parent's, producing a line that exceeded the available
 * width by a few cells. The pi TUI's hard width assertion then crashed the
 * process with "Rendered line N exceeds terminal width".
 *
 * Always creating a fresh `Text` with `paddingX=0` makes the parent's
 * `paddingX` the only source of padding, eliminating the double-padding
 * path. The per-line truncation in `setText` is a defense-in-depth measure:
 * even if a future renderer adds another padding layer, the lines stored
 * in the Text are already within bounds.
 */
export function makeOutputText(content: string, paddingX = 0): Text {
	const safeWidth = getSafeLineWidth();
	// Match Pi's native Text renderer: tabs occupy three spaces there.
	const normalizedContent = content.replace(/\t/g, "   ");
	const safeContent = normalizedContent
		.split(/\r\n|\r|\n/)
		.map((line) => truncateToWidth(line, safeWidth, "…"))
		.join("\n");
	return new Text(safeContent, paddingX, 0);
}

export class Text {
	private text: string;
	public paddingX: number;
	public paddingY: number;

	constructor(text = "", paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text: string) {
		this.text = text;
	}

	getText(): string {
		return this.text;
	}

	/** Satisfies the pi-tui `Component` contract (no cached state to invalidate). */
	invalidate(): void {}

	render(width: number): string[] {
		width = Math.max(1, Math.floor(width));
		if (!this.text || this.text.trim() === "") return [];
		const paddingX = Math.min(
			this.paddingX,
			Math.max(0, Math.floor((width - 1) / 2)),
		);
		const normalizedText = this.text.replace(/\t/g, "   ");
		const contentWidth = Math.max(1, width - paddingX * 2);
		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);
		const leftMargin = " ".repeat(paddingX);
		const rightMargin = " ".repeat(paddingX);
		const contentLines = wrappedLines.map(
			(line) => leftMargin + line + rightMargin,
		);
		// The width argument is authoritative: Pi hard-fails if any returned
		// line exceeds it, regardless of the width available during formatting.
		const safeContentLines = contentLines.map((line) =>
			truncateToWidth(line, width, ""),
		);
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			emptyLines.push(emptyLine);
		}
		return [...emptyLines, ...safeContentLines, ...emptyLines];
	}
}

function matchesKittyUnmodified(data: string, codepoints: number[]): boolean {
	const match = /^\x1b\[(\d+)(?::\d+)?(?:;(\d+)(?::(\d+))?)?u$/.exec(data);
	if (!match) return false;
	const cp = Number(match[1]);
	if (!codepoints.includes(cp)) return false;
	const mod = match[2] ? Number(match[2]) : 1;
	const eventType = match[3] ? Number(match[3]) : 1;
	return mod === 1 && eventType !== 3;
}

function matchesKittyCtrl(data: string, codepoint: number): boolean {
	const match = /^\x1b\[(\d+)(?::\d+)?;(\d+)(?::(\d+))?u$/.exec(data);
	if (!match) return false;
	const cp = Number(match[1]);
	const mod = Number(match[2]);
	const eventType = match[3] ? Number(match[3]) : 1;
	return cp === codepoint && mod === 5 && eventType !== 3;
}

function matchesModifyOtherKeys(data: string, codepoint: number, modifier = 1): boolean {
	const match = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
	if (!match) return false;
	return Number(match[1]) === modifier && Number(match[2]) === codepoint;
}

function matchesArrow(data: string, letter: "A" | "B" | "C" | "D"): boolean {
	if (data === `\x1b[${letter}` || data === `\x1bO${letter}`) return true;
	const match = new RegExp(`^\\x1b\\[1;1(?::([12]))?${letter}$`).exec(data);
	return Boolean(match);
}

export function matchesKey(data: string, key: string): boolean {
	switch (key.toLowerCase()) {
		case "escape":
			return (
				data === "\x1b" ||
				data === "\x1b\x1b" ||
				matchesKittyUnmodified(data, [27]) ||
				matchesModifyOtherKeys(data, 27)
			);
		case "q":
			return data === "q" || data === "Q" || matchesKittyUnmodified(data, [113, 81]);
		case "ctrl+c":
			return (
				data === "\x03" ||
				matchesKittyCtrl(data, 99) ||
				matchesModifyOtherKeys(data, 99, 5)
			);
		case "up":
			return matchesArrow(data, "A");
		case "down":
			return matchesArrow(data, "B");
		case "left":
			return matchesArrow(data, "D");
		case "right":
			return matchesArrow(data, "C");
		case "k":
			return data === "k" || data === "K" || matchesKittyUnmodified(data, [107, 75]);
		case "j":
			return data === "j" || data === "J" || matchesKittyUnmodified(data, [106, 74]);
		case "h":
			return data === "h" || data === "H" || matchesKittyUnmodified(data, [104, 72]);
		case "l":
			return data === "l" || data === "L" || matchesKittyUnmodified(data, [108, 76]);
		case "return":
		case "enter":
			return (
				data === "\r" ||
				data === "\n" ||
				data === "\x1bOM" ||
				matchesKittyUnmodified(data, [13, 57414]) ||
				matchesModifyOtherKeys(data, 13)
			);
		case "space":
			return (
				data === " " ||
				matchesKittyUnmodified(data, [32]) ||
				matchesModifyOtherKeys(data, 32)
			);
		case "tab":
			return (
				data === "\t" ||
				matchesKittyUnmodified(data, [9]) ||
				matchesModifyOtherKeys(data, 9)
			);
		default:
			return data === key;
	}
}
