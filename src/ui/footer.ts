/**
 * Unified Integrated Footer Component
 *
 * Implements clean bullet-separated layout:
 * `<workspace> (branch) • <search:profile> • <context_usage / context_window> • <token I/O>       <model> • <thinking>`
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { getSearchConfig } from "../retrieval/search_config";
import { stripAnsi, truncateToWidth, visibleWidth } from "./tui_utils";

export { stripAnsi, truncateToWidth, visibleWidth } from "./tui_utils";

export interface FooterTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface FooterDataProvider {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(listener: () => void): () => void;
}

/**
 * Aesthetic Semantic Pastel Color Palette (TrueColor 24-bit ANSI)
 * Designed for low visual fatigue and crisp semantic hierarchy.
 */
const RESET = "\x1b[0m";
export const Pastel = {
	reset: RESET,
	bullet: "\x1b[38;2;95;105;120m•\x1b[0m", // Muted slate delimiter (#5f6978)

	// Workspace & Git Branch
	path: (s: string) => `\x1b[38;2;140;185;215m${s}${RESET}`, // Soft Ice Cyan (#8cb9d7)
	branch: (s: string) => `\x1b[38;2;185;165;225m${s}${RESET}`, // Soft Lavender (#b9a5e1)

	// Search Engine Profiles
	searchLean: (s: string) => `\x1b[38;2;135;205;195m${s}${RESET}`, // Pastel Seafoam (#87cdc3)
	searchHybrid: (s: string) => `\x1b[38;2;195;165;215m${s}${RESET}`, // Pastel Lilac (#c3a5d7)
	searchFull: (s: string) => `\x1b[38;2;165;175;235m${s}${RESET}`, // Pastel Periwinkle (#a5afeb)
	searchOff: (s: string) => `\x1b[38;2;135;140;150m${s}${RESET}`, // Muted Slate (#878c96)

	// Context Window Usage (Semantic Gauge)
	contextGood: (s: string) => `\x1b[38;2;155;210;170m${s}${RESET}`, // Pastel Mint (#9bd2aa) < 70%
	contextWarn: (s: string) => `\x1b[38;2;245;195;125m${s}${RESET}`, // Pastel Apricot (#f5c37d) 70-90%
	contextCrit: (s: string) => `\x1b[38;2;240;140;145m${s}${RESET}`, // Pastel Soft Rose (#f08c91) > 90%

	// Token I/O & Cost
	tokenIO: (s: string) => `\x1b[38;2;170;180;195m${s}${RESET}`, // Pastel Slate Gray (#aab4c3)
	tokenCost: (s: string) => `\x1b[38;2;225;215;140m${s}${RESET}`, // Pastel Pale Gold (#e1d78c)

	// Model & Reasoning
	provider: (s: string) => `\x1b[38;2;140;150;165m${s}${RESET}`, // Slate Dim
	model: (s: string) => `\x1b[38;2;225;230;240m${s}${RESET}`, // Soft Pearl White (#e1e6f0)
	thinking: (s: string) => `\x1b[38;2;180;170;220m${s}${RESET}`, // Pastel Wisteria (#b4aadc)
	thinkingOff: (s: string) => `\x1b[38;2;135;140;150m${s}${RESET}`, // Muted Dim (#878c96)
};


/**
 * Format numbers into compact token strings (e.g. 1.2k, 45k, 1.2M)
 */
export function formatTokens(count: number): string {
	if (isNaN(count) || count < 0) return "0";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Format working directory path using `~` shorthand
 */
export function formatCwd(cwd: string, home: string = process.env.HOME || process.env.USERPROFILE || ""): string {
	if (!home || !cwd) return cwd || ".";
	try {
		const resolvedCwd = resolve(cwd);
		const resolvedHome = resolve(home);
		const rel = relative(resolvedHome, resolvedCwd);
		const isInsideHome =
			rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
		if (!isInsideHome) return cwd;
		return rel === "" ? "~" : `~${sep}${rel}`.replace(/\\/g, "/");
	} catch {
		return cwd;
	}
}

/**
 * Format search engine mode tag with technical naming and semantic pastel colors:
 * - Lean -> `retrieval:bm25`
 * - Hybrid -> `retrieval:hybrid-256d`
 * - Full -> `retrieval:dense-768d`
 * - Off -> `retrieval:off`
 */
export function formatSearchEngineTag(searchIndexOrProfile?: any, withColor = true): string {
	let eff = "lean";
	if (!searchIndexOrProfile) {
		try {
			eff = getSearchConfig().effectiveProfile;
		} catch {
			eff = "lean";
		}
	} else if (typeof searchIndexOrProfile === "string") {
		eff = searchIndexOrProfile.toLowerCase();
	} else if (typeof searchIndexOrProfile.getEffectiveProfile === "function") {
		eff = searchIndexOrProfile.getEffectiveProfile();
	} else if (typeof searchIndexOrProfile.getProfile === "function") {
		eff = searchIndexOrProfile.getProfile();
	}

	let label = "retrieval:bm25";
	if (eff === "lean") {
		label = "retrieval:bm25";
		return withColor ? Pastel.searchLean(label) : label;
	}
	if (eff === "hybrid") {
		label = "retrieval:hybrid-256d";
		return withColor ? Pastel.searchHybrid(label) : label;
	}
	if (eff === "full") {
		label = "retrieval:dense-768d";
		return withColor ? Pastel.searchFull(label) : label;
	}
	label = `retrieval:${eff}`;
	return withColor ? Pastel.searchOff(label) : label;
}

/**
 * Render the unified footer lines with rich semantic pastel styling
 */
export function renderFooter(
	ctx: any,
	theme: FooterTheme,
	footerData: FooterDataProvider,
	width: number,
	searchIndex?: any
): string[] {
	const parts: string[] = [];

	// 1. Workspace & Git Branch
	const rawCwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
	const pwdStr = formatCwd(rawCwd);
	const branch = footerData?.getGitBranch?.();
	let workspaceFormatted = Pastel.path(pwdStr);
	if (branch) {
		workspaceFormatted += ` ${Pastel.branch(`(${branch})`)}`;
	}
	parts.push(workspaceFormatted);

	// 2. Search Engine Mode
	const searchTag = formatSearchEngineTag(searchIndex, true);
	parts.push(searchTag);

	// 3. Context Window Usage
	const contextUsage = ctx.getContextUsage?.();
	const model = ctx.model;
	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const percentValue = contextUsage?.percent;
	const tokensValue = contextUsage?.tokens;

	if (contextWindow > 0) {
		let rawContextStr: string;
		if (tokensValue !== null && tokensValue !== undefined) {
			const pctStr = percentValue !== null && percentValue !== undefined ? ` (${percentValue.toFixed(0)}%)` : "";
			rawContextStr = `${formatTokens(tokensValue)}/${formatTokens(contextWindow)}${pctStr}`;
		} else if (percentValue !== null && percentValue !== undefined) {
			rawContextStr = `${percentValue.toFixed(1)}%/${formatTokens(contextWindow)}`;
		} else {
			rawContextStr = `0/${formatTokens(contextWindow)}`;
		}

		// Colorize semantically based on context window load
		let formattedContext: string;
		if (percentValue !== null && percentValue !== undefined) {
			if (percentValue > 90) {
				formattedContext = Pastel.contextCrit(rawContextStr);
			} else if (percentValue > 70) {
				formattedContext = Pastel.contextWarn(rawContextStr);
			} else {
				formattedContext = Pastel.contextGood(rawContextStr);
			}
		} else {
			formattedContext = Pastel.contextGood(rawContextStr);
		}
		parts.push(formattedContext);
	}

	// 4. Cumulative Token I/O & Cost
	let totalIn = 0;
	let totalOut = 0;
	let totalCost = 0;
	const entries = ctx.sessionManager?.getEntries?.() || [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
			totalIn += entry.message.usage.input || 0;
			totalOut += entry.message.usage.output || 0;
			totalCost += entry.message.usage.cost?.total || 0;
		}
	}

	if (totalIn > 0 || totalOut > 0) {
		let ioFormatted = Pastel.tokenIO(`↑${formatTokens(totalIn)} ↓${formatTokens(totalOut)}`);
		if (totalCost > 0) {
			const costStr = "$" + totalCost.toFixed(3);
			ioFormatted += ` ${Pastel.tokenCost(costStr)}`;
		}
		parts.push(ioFormatted);
	}

	const left = parts.join(` ${Pastel.bullet} `);

	// 5. Right Side: Model & Thinking Level
	const modelName = model?.id || "no-model";
	let rightFormatted = Pastel.model(modelName);

	if (model?.reasoning) {
		const thinking = ctx.thinkingLevel || "off";
		const thinkingTag =
			thinking === "off"
				? `${Pastel.bullet} ${Pastel.thinkingOff("thinking off")}`
				: `${Pastel.bullet} ${Pastel.thinking(thinking)}`;
		rightFormatted += ` ${thinkingTag}`;
	}

	if (footerData?.getAvailableProviderCount?.() > 1 && model?.provider) {
		rightFormatted = `${Pastel.provider(`(${model.provider})`)} ${rightFormatted}`;
	}

	// Calculate widths and padding
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(rightFormatted);
	const minPadding = 2;

	let mainLine: string;
	if (leftWidth + minPadding + rightWidth <= width) {
		const pad = " ".repeat(width - leftWidth - rightWidth);
		mainLine = left + pad + rightFormatted;
	} else if (leftWidth + minPadding <= width) {
		const availForRight = width - leftWidth - minPadding;
		const truncatedRight = truncateToWidth(rightFormatted, availForRight, "");
		const pad = " ".repeat(Math.max(1, width - leftWidth - visibleWidth(truncatedRight)));
		mainLine = left + pad + truncatedRight;
	} else {
		mainLine = truncateToWidth(left, width, "...");
	}

	const lines: string[] = [mainLine];

	// Optional: Extension statuses (if any)
	const extStatuses = footerData?.getExtensionStatuses?.();
	if (extStatuses && extStatuses.size > 0) {
		const statusTexts = Array.from(extStatuses.values()).filter(Boolean);
		if (statusTexts.length > 0) {
			lines.push(truncateToWidth(theme.fg("dim", statusTexts.join(" • ")), width, "..."));
		}
	}

	return lines;
}
