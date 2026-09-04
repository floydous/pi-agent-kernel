import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth } from "../ui/tui_utils";
import { HybridSearchIndex } from "./search_index";
import { SearchProfile } from "./search_config";

export interface ModalResult {
	action: string;
	profile?: SearchProfile;
	reindexed?: boolean;
}

export class SearchControlModal implements Focusable {
	focused = false;

	private tui: any;
	private index: HybridSearchIndex;
	private theme: Theme;
	private done: (result: ModalResult | undefined) => void;
	private selectedIndex = 0;
	private initialProfile: SearchProfile;

	// Menu items categorized
	private items: Array<{
		id: string;
		category: "profile" | "action";
		label: string;
		desc: string;
		profile?: SearchProfile;
	}> = [
		// Category: Profiles
		{
			id: "auto",
			category: "profile",
			profile: "auto",
			label: "Auto Detect",
			desc: "Auto-detect Lean (VPS), Hybrid (Laptop), or Full (Desktop)",
		},
		{
			id: "lean",
			category: "profile",
			profile: "lean",
			label: "Lean Mode",
			desc: "AST BM25 (0% CPU, 0 MB extra RAM)",
		},
		{
			id: "hybrid",
			category: "profile",
			profile: "hybrid",
			label: "Hybrid Mode",
			desc: "Throttled 256-dim Matryoshka embeddings",
		},
		{
			id: "full",
			category: "profile",
			profile: "full",
			label: "Full Mode",
			desc: "Multi-core 768-dim embeddings",
		},
		{
			id: "off",
			category: "profile",
			profile: "off",
			label: "Disable Engine",
			desc: "Turn off search & free memory",
		},
		// Category: Workspace Actions
		{
			id: "reindex",
			category: "action",
			label: "Re-index Workspace",
			desc: "Scan all source files and rebuild index",
		},
		{
			id: "close",
			category: "action",
			label: "Close Panel",
			desc: "Dismiss this dialog",
		},
	];

	constructor(
		tui: any,
		index: HybridSearchIndex,
		theme: Theme,
		done: (result: ModalResult | undefined) => void
	) {
		this.tui = tui;
		this.index = index;
		this.theme = theme;
		this.done = done;
		this.initialProfile = index.getProfile();

		// Set initial cursor to current active profile
		const currentProfile = this.initialProfile;
		const idx = this.items.findIndex((item) => item.profile === currentProfile);
		if (idx >= 0) this.selectedIndex = idx;
	}

	async handleInput(data: string): Promise<void> {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			const currentProfile = this.index.getProfile();
			const changed = currentProfile !== this.initialProfile;
			this.done({ action: "close", profile: currentProfile, reindexed: changed });
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "space")) {
			const item = this.items[this.selectedIndex];
			if (!item) return;

			if (item.category === "profile" && item.profile) {
				this.index.setProfile(item.profile);
				const changed = item.profile !== this.initialProfile;
				this.done({ action: "select", profile: item.profile, reindexed: changed });
				return;
			}

			if (item.id === "reindex") {
				const currentProfile = this.index.getProfile();
				this.done({ action: "reindex", profile: currentProfile, reindexed: true });
				return;
			}

			if (item.id === "close") {
				const currentProfile = this.index.getProfile();
				const changed = currentProfile !== this.initialProfile;
				this.done({ action: "close", profile: currentProfile, reindexed: changed });
				return;
			}
		}
	}

	render(width: number): string[] {
		const cardWidth = Math.min(108, Math.max(20, width - 4));
		const innerW = Math.max(1, cardWidth - 2);

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			if (vis > len) {
				return truncateToWidth(s, len, "...");
			}
			return s + " ".repeat(Math.max(0, len - vis));
		};

		// Signature Dark Slate / Charcoal Minimalist Theme Palette
		const reset = "\x1b[0m";
		const bgCard = "\x1b[48;5;234m"; // Dark charcoal matte card background

		// Clean Monochrome & Dark Slate Foreground Colors (TrueColor with fallback-safe ANSI escapes)
		const fgBorder = "\x1b[38;5;240m"; // Refined dark slate/gray border (#585858)
		const fgTitle = "\x1b[1;38;5;255m"; // Pure crisp white bold title
		const fgSubHeader = "\x1b[1;38;5;250m"; // Light silver bold for section headers (#bcbcbc)
		const fgActive = "\x1b[1;38;5;255m"; // Pure white highlight for active/selected item
		const fgSelected = "\x1b[38;5;252m"; // Crisp light gray for selected radios (#d0d0d0)
		const fgStatusReady = "\x1b[38;5;250m"; // Light slate for ready status
		const fgValue = "\x1b[38;5;252m"; // Crisp silver-gray for metrics and values
		const fgNotice = "\x1b[38;5;215m"; // Soft muted amber for download/sync alerts
		const fgMuted = "\x1b[38;5;245m"; // Mid slate gray (#8a8a8a) for labels
		const fgDim = "\x1b[38;5;239m"; // Dimmed charcoal gray (#4e4e4e) for secondary text and bullets

		const row = (content: string) =>
			bgCard + fgBorder + "│" + reset + bgCard + pad(content, innerW) + fgBorder + "│" + reset;

		const status = this.index.getStatus();
		const currentProfile = this.index.getProfile();

		// Determine semantic color for model status
		let modelColor = fgMuted;
		if (status.modelStatus.includes("Active in RAM")) {
			modelColor = fgActive;
		} else if (status.modelStatus.includes("Active (BM25")) {
			modelColor = fgStatusReady;
		} else if (status.modelStatus.includes("Cached on disk")) {
			modelColor = fgValue;
		} else if (status.modelStatus.includes("Not downloaded")) {
			modelColor = fgNotice;
		} else if (status.modelStatus === "Disabled") {
			modelColor = fgDim;
		}

		const cardLines: string[] = [];

		// Header
		cardLines.push(bgCard + fgBorder + `╭${"─".repeat(innerW)}╮` + reset);
		cardLines.push(row(` ${fgTitle}Codebase Retrieval Engine${reset}${bgCard}  ${fgDim}(Hybrid AST & Vector)`));
		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);

		// Status section
		cardLines.push(row(` ${fgSubHeader}Status:`));
		cardLines.push(
			row(
				`   ${fgMuted}Engine  : ${fgActive}${status.engineState}${fgMuted}  (${fgValue}${status.pipelineDesc}${fgMuted})`
			)
		);
		cardLines.push(
			row(
				`   ${fgMuted}Default : ${fgTitle}${currentProfile.toUpperCase()}${fgMuted}  ${fgDim}(~/.pi/agent/search_settings.json)`
			)
		);
		cardLines.push(
			row(
				`   ${fgMuted}Active  : ${fgValue}${status.effectiveProfile.toUpperCase()}${fgMuted}  (${fgDim}${status.hardwareInfo}${fgMuted})`
			)
		);
		cardLines.push(
			row(
				`   ${fgMuted}Index   : ${fgValue}${status.chunkCount}${fgMuted} chunks in ${fgValue}${status.fileCount}${fgMuted} files  |  ${status.vectorCount > 0 ? fgValue : fgDim}${status.vectorCount} vectors`
			)
		);
		cardLines.push(
			row(
				`   ${fgMuted}Model   : ${modelColor}${status.modelStatus}`
			)
		);
		cardLines.push(
			row(
				`   ${fgMuted}Memory  : ${fgMuted}RSS ${fgValue}${status.rssMemoryMB} MB`
			)
		);

		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);
		cardLines.push(row(` ${fgSubHeader}Engine Profiles:`));

		// Render profile items
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			if (item.category === "profile") {
				const isSelected = i === this.selectedIndex;
				const isCurrentProfile = item.profile === currentProfile;

				const cursor = isSelected ? `${fgTitle} > ` : "   ";
				const radio = isCurrentProfile ? `${fgSelected}[x]` : `${fgDim}[ ]`;

				const labelText = isSelected
					? `${fgActive}${item.label}`
					: isCurrentProfile
					? `${fgSelected}${item.label}`
					: `${fgMuted}${item.label}`;

				let descExtra = "";
				if (item.profile === "hybrid" || item.profile === "full") {
					if (!status.isModelCached) {
						descExtra = ` ${fgNotice}(Not downloaded, ~135 MB)`;
					} else {
						descExtra = ` ${fgStatusReady}(ready)`;
					}
				}

				const descText = `${fgDim}- ${item.desc}${descExtra}`;
				const lineStr = `${cursor}${radio} ${labelText} ${descText}`;

				cardLines.push(row(lineStr));
			}
		}

		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);
		cardLines.push(row(` ${fgSubHeader}Workspace Actions:`));

		// Render action items
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			if (item.category === "action") {
				const isSelected = i === this.selectedIndex;
				const cursor = isSelected ? `${fgTitle} > ` : "   ";
				const bullet = `${fgDim}[-]`;

				const labelText = isSelected
					? `${fgActive}${item.label}`
					: `${fgMuted}${item.label}`;

				const descText = `${fgDim}- ${item.desc}`;
				const lineStr = `${cursor}${bullet} ${labelText} ${descText}`;

				cardLines.push(row(lineStr));
			}
		}

		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);
		cardLines.push(
			row(
				` ${fgDim}Up/Down: Navigate  |  Enter: Select/Toggle  |  Esc: Close`
			)
		);
		cardLines.push(bgCard + fgBorder + `╰${"─".repeat(innerW)}╯` + reset);

		// Terminal height resolution for full-viewport coverage
		const termHeight =
			this.tui?.terminal?.rows ||
			(process.stdout && process.stdout.rows ? process.stdout.rows : 24);

		// Layout calculations for full-screen backdrop framing
		const leftPad = Math.max(0, Math.floor((width - cardWidth) / 2));
		const rightPad = Math.max(0, width - cardWidth - leftPad);

		// Dark monochrome backdrop: deep black background with dark gray stippling
		const scrim = (len: number) =>
			len <= 0 ? "" : "\x1b[48;5;232m\x1b[38;5;234m" + "░".repeat(len) + reset;

		// Deep dark right drop shadow
		const shadowRight = (len: number) => {
			if (len <= 0) return "";
			return "\x1b[48;5;232m\x1b[38;5;233m▌" + reset + scrim(len - 1);
		};

		// Deep dark bottom drop shadow
		const shadowBottom = (left: number, card: number, right: number) => {
			return (
				scrim(left) +
				"\x1b[48;5;232m\x1b[38;5;233m" +
				"▀".repeat(card) +
				reset +
				scrim(right)
			);
		};

		const totalCardRows = cardLines.length + 1; // Card lines + bottom shadow row
		const topPad = Math.max(0, Math.floor((termHeight - totalCardRows) / 2));
		const bottomPad = Math.max(0, termHeight - totalCardRows - topPad);

		const fullLines: string[] = [];

		// Top backdrop scrim rows to fill viewport from top down to modal
		for (let i = 0; i < topPad; i++) {
			fullLines.push(scrim(width));
		}

		// Centered card rows with left/right scrim and right shadow
		for (let i = 0; i < cardLines.length; i++) {
			const line = scrim(leftPad) + cardLines[i] + shadowRight(rightPad);
			fullLines.push(line);
		}

		// Bottom shadow row
		fullLines.push(shadowBottom(leftPad, cardWidth, rightPad));

		// Bottom backdrop scrim rows to fill viewport down to bottom edge
		for (let i = 0; i < bottomPad; i++) {
			fullLines.push(scrim(width));
		}

		return fullLines;
	}

	invalidate(): void {}
	dispose(): void {}
}
