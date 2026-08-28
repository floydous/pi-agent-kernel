import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth } from "../ui/tui_utils";
import { LspManager } from "./lsp_manager";
import {
	LSP_SERVERS,
	findExecutable,
	isServerDisabled,
	toggleServerEnabled,
	clearExecutableCache,
} from "./lsp_registry";
import { installLanguageServer } from "./lsp_installer";

export interface LspModalResult {
	action: "install" | "stop" | "close";
	target?: string;
	installTargets?: string[];
}

interface ServerRowItem {
	type: "server";
	id: string;
	label: string;
	binDesc: string;
}

interface ActionRowItem {
	type: "action";
	id: "stop-all" | "close";
	label: string;
	desc: string;
}

type ModalItem = ServerRowItem | ActionRowItem;

const SERVER_ITEMS: ServerRowItem[] = [
	{ type: "server", id: "typescript", label: "TypeScript / JS", binDesc: "vtsls, biome, oxc" },
	{ type: "server", id: "python", label: "Python", binDesc: "ty, ruff, pyright" },
	{ type: "server", id: "rust", label: "Rust", binDesc: "rust-analyzer" },
	{ type: "server", id: "go", label: "Go", binDesc: "gopls" },
	{ type: "server", id: "cpp", label: "C / C++", binDesc: "clangd" },
	{ type: "server", id: "zig", label: "Zig", binDesc: "zls" },
	{ type: "server", id: "html", label: "HTML / Web", binDesc: "superhtml (Zig), vscode" },
	{ type: "server", id: "json", label: "JSON / Schema", binDesc: "biome (Rust), vscode" },
	{ type: "server", id: "markdown", label: "Markdown", binDesc: "marksman, oxide" },
	{ type: "server", id: "toml", label: "TOML", binDesc: "taplo (Rust)" },
	{ type: "server", id: "typst", label: "Typst", binDesc: "tinymist (Rust)" },
	{ type: "server", id: "sql", label: "SQL", binDesc: "sqruff (Rust), sqls" },
	{ type: "server", id: "lua", label: "Lua", binDesc: "lua-language-server" },
	{ type: "server", id: "shell", label: "Shell / Bash", binDesc: "bash-language-server" },
	{ type: "server", id: "yaml", label: "YAML", binDesc: "yaml-language-server" },
	{ type: "server", id: "csharp", label: "C# / .NET", binDesc: "csharp-ls, OmniSharp" },
	{ type: "server", id: "ruby", label: "Ruby", binDesc: "ruby-lsp, solargraph" },
	{ type: "server", id: "java", label: "Java", binDesc: "jdtls" },
	{ type: "server", id: "kotlin", label: "Kotlin", binDesc: "kotlin-lsp, fwcd" },
	{ type: "server", id: "swift", label: "Swift", binDesc: "sourcekit-lsp" },
	{ type: "server", id: "php", label: "PHP", binDesc: "intelephense" },
	{ type: "server", id: "docker", label: "Dockerfile", binDesc: "docker-langserver" },
];

const ACTION_ITEMS: ActionRowItem[] = [
	{ type: "action", id: "stop-all", label: "Stop All Active Daemons", desc: "Terminate all running subprocesses" },
	{ type: "action", id: "close", label: "Close Panel", desc: "Dismiss this dialog and start queued downloads" },
];

function checkServerInstalled(id: string): { installed: boolean; activeBin?: string; binPath?: string } {
	const cfg = LSP_SERVERS[id];
	if (!cfg) return { installed: false };
	for (const cmd of cfg.commands) {
		const binPath = findExecutable(cmd.bin);
		if (binPath) {
			return { installed: true, activeBin: cmd.bin, binPath };
		}
	}
	return { installed: false, activeBin: cfg.commands[0]?.bin };
}

export class LspControlModal implements Focusable {
	focused = false;

	private tui: any;
	private lspMgr: LspManager;
	private theme: Theme;
	private done: (result: LspModalResult | undefined) => void;
	private selectedIndex = 0;
	private allItems: ModalItem[];
	private queuedInstalls = new Set<string>();

	constructor(
		tui: any,
		lspMgr: LspManager,
		theme: Theme,
		done: (result: LspModalResult | undefined) => void
	) {
		this.tui = tui;
		this.lspMgr = lspMgr;
		this.theme = theme;
		this.done = done;
		this.allItems = [...SERVER_ITEMS, ...ACTION_ITEMS];
	}

	private finish(action: "install" | "stop" | "close", target?: string) {
		const installTargets = Array.from(this.queuedInstalls);
		this.done({
			action,
			target,
			installTargets: installTargets.length > 0 ? installTargets : target ? [target] : undefined,
		});
	}

	async handleInput(data: string): Promise<void> {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.finish("close");
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = (this.selectedIndex - 1 + this.allItems.length) % this.allItems.length;
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = (this.selectedIndex + 1) % this.allItems.length;
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, "s")) {
			await this.lspMgr.stopAll();
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, "r")) {
			clearExecutableCache();
			this.tui?.requestRender?.();
			return;
		}

		// Space key: Toggle on/off if installed, or queue/unqueue download if not installed
		if (matchesKey(data, "space")) {
			const item = this.allItems[this.selectedIndex];
			if (!item) return;

			if (item.type === "server") {
				const status = checkServerInstalled(item.id);
				if (!status.installed) {
					// Toggle queued install
					if (this.queuedInstalls.has(item.id)) {
						this.queuedInstalls.delete(item.id);
					} else {
						this.queuedInstalls.add(item.id);
					}
					this.tui?.requestRender?.();
					return;
				} else {
					const nowEnabled = toggleServerEnabled(item.id);
					if (!nowEnabled) {
						await this.lspMgr.stopLanguage(item.id);
					}
					this.tui?.requestRender?.();
					return;
				}
			} else if (item.type === "action") {
				if (item.id === "stop-all") {
					await this.lspMgr.stopAll();
					this.tui?.requestRender?.();
					return;
				} else if (item.id === "close") {
					this.finish("close");
					return;
				}
			}
		}

		// Enter / Return key
		if (matchesKey(data, "return")) {
			const item = this.allItems[this.selectedIndex];
			if (!item) return;

			if (item.type === "server") {
				const status = checkServerInstalled(item.id);
				if (!status.installed) {
					if (this.queuedInstalls.has(item.id)) {
						this.queuedInstalls.delete(item.id);
					} else {
						this.queuedInstalls.add(item.id);
					}
					this.tui?.requestRender?.();
				} else {
					const nowEnabled = toggleServerEnabled(item.id);
					if (!nowEnabled) {
						await this.lspMgr.stopLanguage(item.id);
					}
					this.tui?.requestRender?.();
				}
				return;
			} else if (item.type === "action") {
				if (item.id === "stop-all") {
					await this.lspMgr.stopAll();
					this.finish("stop");
				} else if (item.id === "close") {
					this.finish("close");
				}
				return;
			}
		}
	}

	render(width: number): string[] {
		const cardWidth = Math.min(104, Math.max(20, width - 4));
		const innerW = Math.max(1, cardWidth - 2);

		const pad = (s: string, len: number) => {
			const safe = truncateToWidth(s, len, "");
			return safe + " ".repeat(Math.max(0, len - visibleWidth(safe)));
		};

		// Theme Palette (Pastel TrueColor & Dark Charcoal Matte)
		const reset = "\x1b[0m";
		const bgCard = "\x1b[48;5;234m"; // Dark charcoal matte card background

		const fgBorder = "\x1b[38;5;240m"; // Refined dark slate/gray border (#585858)
		const fgTitle = "\x1b[1;38;5;255m"; // Pure crisp white bold title
		const fgSubHeader = "\x1b[1;38;5;250m"; // Light silver bold for section headers (#bcbcbc)
		const fgActiveCursor = "\x1b[1;38;5;255m"; // Pure white highlight for active cursor
		const fgSelected = "\x1b[38;5;252m"; // Crisp light gray for labels
		const fgStatusReady = "\x1b[38;2;155;210;170m"; // Pastel Mint (#9bd2aa) for enabled / installed [x]
		const fgDownload = "\x1b[38;2;230;190;130m"; // Soft Pastel Amber/Sand (#e6be82) for (download) indicator
		const fgQueue = "\x1b[1;38;2;140;210;240m"; // Pastel Sky Cyan (#8cd2f0) for queued downloads
		const fgDisabled = "\x1b[38;5;242m"; // Dim slate gray for [ ] disabled
		const fgValue = "\x1b[38;5;252m"; // Crisp silver-gray for metrics
		const fgNotice = "\x1b[38;5;215m"; // Soft muted amber for alerts
		const fgMuted = "\x1b[38;5;245m"; // Mid slate gray for secondary labels
		const fgDim = "\x1b[38;5;239m"; // Dimmed charcoal gray for details

		const row = (content: string) =>
			bgCard + fgBorder + "│" + reset + bgCard + pad(content, innerW) + fgBorder + "│" + reset;

		const activeClients = this.lspMgr.getStatus();
		const cardLines: string[] = [];

		// Header
		cardLines.push(bgCard + fgBorder + `╭${"─".repeat(innerW)}╮` + reset);
		cardLines.push(row(` ${fgTitle}Language Server Protocol (LSP)${reset}${bgCard}  ${fgDim}(Tree-sitter AST & Stdio Daemons)`));
		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);

		// Active Daemons Status Section
		cardLines.push(row(` ${fgSubHeader}Active LSP Daemons (${fgValue}${activeClients.length}${fgSubHeader}):`));
		if (activeClients.length === 0) {
			cardLines.push(row(`   ${fgDim}None (LSP daemons spawn automatically on demand when queried)`));
		} else {
			for (const c of activeClients) {
				const stateColor = c.state === "ready" ? fgStatusReady : fgNotice;
				cardLines.push(
					row(
						`   ${fgTitle}• ${c.languageId.toUpperCase()}${fgMuted} (State: ${stateColor}${c.state}${fgMuted}, Idle: ${fgValue}${c.idleSeconds}s${fgMuted})  ${fgDim}${c.rootDir}`
					)
				);
			}
		}

		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);
		
		// Section title with queued counter if any
		if (this.queuedInstalls.size > 0) {
			cardLines.push(row(` ${fgSubHeader}Available Server Binaries  ${fgQueue}[${this.queuedInstalls.size} queued for download upon exit]${reset}${bgCard}:`));
		} else {
			cardLines.push(row(` ${fgSubHeader}Available Server Binaries:`));
		}

		// Terminal height resolution for dynamic scrolling viewport
		const termHeight =
			this.tui?.terminal?.rows ||
			(process.stdout && process.stdout.rows ? process.stdout.rows : 24);

		const maxVisibleServers = Math.max(6, Math.min(10, termHeight - 16));
		const numServers = SERVER_ITEMS.length;

		let scrollOffset = 0;
		if (this.selectedIndex < numServers) {
			if (this.selectedIndex >= scrollOffset + maxVisibleServers) {
				scrollOffset = this.selectedIndex - maxVisibleServers + 1;
			}
		} else {
			scrollOffset = Math.max(0, numServers - maxVisibleServers);
		}
		scrollOffset = Math.max(0, Math.min(scrollOffset, numServers - maxVisibleServers));

		if (scrollOffset > 0) {
			cardLines.push(row(`   ${fgDim}▲ (${scrollOffset} more servers above)`));
		}

		const visibleEnd = Math.min(numServers, scrollOffset + maxVisibleServers);
		for (let i = scrollOffset; i < visibleEnd; i++) {
			const item = SERVER_ITEMS[i];
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? `${fgActiveCursor} > ` : "   ";

			const status = checkServerInstalled(item.id);
			const isQueued = this.queuedInstalls.has(item.id);
			const disabled = isServerDisabled(item.id);
			const isEnabled = status.installed && !disabled;
			const isActive = activeClients.some(
				(c) => c.languageId.toLowerCase() === item.id.toLowerCase()
			);

			// Checkbox representation
			let checkbox = `${fgDisabled}[ ]${reset}${bgCard}`;
			if (isQueued) {
				checkbox = `${fgQueue}[+]${reset}${bgCard}`;
			} else if (isEnabled) {
				checkbox = `${fgStatusReady}[x]${reset}${bgCard}`;
			}

			// Server name label
			const nameColor = isSelected ? fgActiveCursor : isQueued ? fgQueue : isEnabled ? fgSelected : fgMuted;
			const nameCol = `${nameColor}${item.label.padEnd(18)}${reset}${bgCard}`;

			// Indicator column
			let indicatorCol = "";
			if (isQueued) {
				indicatorCol = `${fgQueue}(queued)    ${reset}${bgCard}`;
			} else if (!status.installed) {
				indicatorCol = `${fgDownload}(download)  ${reset}${bgCard}`;
			} else if (isActive) {
				indicatorCol = `${fgStatusReady}(active)    ${reset}${bgCard}`;
			} else if (isEnabled) {
				indicatorCol = `${fgStatusReady}(ready)     ${reset}${bgCard}`;
			} else {
				indicatorCol = `${fgDim}(off)       ${reset}${bgCard}`;
			}

			// Details / binary column
			const binText = status.installed
				? `${fgDim}${status.activeBin || item.binDesc}`
				: `${fgDim}${item.binDesc}`;

			cardLines.push(row(`${cursor}${checkbox} ${nameCol} ${indicatorCol} ${binText}`));
		}

		if (visibleEnd < numServers) {
			cardLines.push(row(`   ${fgDim}▼ (${numServers - visibleEnd} more servers below)`));
		}

		// Utility actions section
		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);
		cardLines.push(row(` ${fgSubHeader}Actions & Control:`));

		for (let j = 0; j < ACTION_ITEMS.length; j++) {
			const actionIdx = numServers + j;
			const item = ACTION_ITEMS[j];
			const isSelected = actionIdx === this.selectedIndex;
			const cursor = isSelected ? `${fgActiveCursor} > ` : "   ";
			const bullet = item.id === "stop-all" ? `${fgNotice}[!]` : `${fgDim}[x]`;
			const labelColor = isSelected ? fgActiveCursor : fgMuted;

			cardLines.push(
				row(`${cursor}${bullet} ${labelColor}${item.label.padEnd(28)}${reset}${bgCard} ${fgDim}- ${item.desc}`)
			);
		}

		// Footer Key Hints
		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);
		const footerHint = this.queuedInstalls.size > 0
			? ` ${fgQueue}Space: Toggle  |  Esc: Start ${this.queuedInstalls.size} queued download(s) & Close`
			: ` ${fgDim}Space: Toggle/Queue  |  Enter: Select  |  s: Stop All  |  r: Rescan  |  Esc: Close`;
		cardLines.push(row(footerHint));
		cardLines.push(bgCard + fgBorder + `╰${"─".repeat(innerW)}╯` + reset);

		// Layout calculations for full-screen backdrop framing
		const leftPad = Math.max(0, Math.floor((width - cardWidth) / 2));
		const rightPad = Math.max(0, width - cardWidth - leftPad);

		const scrim = (len: number) =>
			len <= 0 ? "" : "\x1b[48;5;232m\x1b[38;5;234m" + "░".repeat(len) + reset;

		const shadowRight = (len: number) => {
			if (len <= 0) return "";
			return "\x1b[48;5;232m\x1b[38;5;233m▌" + reset + scrim(len - 1);
		};

		const shadowBottom = (left: number, card: number, right: number) => {
			return (
				scrim(left) +
				"\x1b[48;5;232m\x1b[38;5;233m" +
				"▀".repeat(card) +
				reset +
				scrim(right)
			);
		};

		const totalCardRows = cardLines.length + 1;
		const topPad = Math.max(0, Math.floor((termHeight - totalCardRows) / 2));
		const bottomPad = Math.max(0, termHeight - totalCardRows - topPad);

		const fullLines: string[] = [];

		for (let i = 0; i < topPad; i++) {
			fullLines.push(scrim(width));
		}

		for (let i = 0; i < cardLines.length; i++) {
			const line = scrim(leftPad) + cardLines[i] + shadowRight(rightPad);
			fullLines.push(line);
		}

		fullLines.push(shadowBottom(leftPad, cardWidth, rightPad));

		for (let i = 0; i < bottomPad; i++) {
			fullLines.push(scrim(width));
		}

		return fullLines;
	}

	invalidate(): void {}
	dispose(): void {}
}

/**
 * Animated ASCII Progress Modal for downloading multiple LSP servers in background
 */
export class LspDownloadModal implements Focusable {
	focused = false;

	private tui: any;
	private targets: string[];
	private theme: Theme;
	private done: () => void;
	private spinnerIndex = 0;
	private spinnerTimer: NodeJS.Timeout | null = null;
	private isRunning = true;
	private isFinished = false;

	// Progress state per item
	private tasks: Array<{
		id: string;
		label: string;
		status: "queued" | "downloading" | "done" | "error";
		progressMsg: string;
		errorMsg?: string;
		binPath?: string;
	}> = [];

	private static readonly SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	constructor(tui: any, targets: string[], theme: Theme, done: () => void) {
		this.tui = tui;
		this.targets = targets;
		this.theme = theme;
		this.done = done;

		this.tasks = targets.map((id) => {
			const cfg = SERVER_ITEMS.find((s) => s.id.toLowerCase() === id.toLowerCase());
			return {
				id,
				label: cfg?.label || id,
				status: "queued",
				progressMsg: "Queued for download...",
			};
		});

		this.startAnimation();
		this.runDownloads();
	}

	private startAnimation() {
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			this.spinnerIndex = (this.spinnerIndex + 1) % LspDownloadModal.SPINNER_FRAMES.length;
			this.tui?.requestRender?.();
		}, 80);
		if (this.spinnerTimer.unref) {
			this.spinnerTimer.unref();
		}
	}

	private stopAnimation() {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = null;
		}
	}

	private async runDownloads() {
		for (let i = 0; i < this.tasks.length; i++) {
			if (!this.isRunning) break;
			const task = this.tasks[i];
			task.status = "downloading";
			task.progressMsg = "Initializing installer...";
			this.tui?.requestRender?.();

			const res = await installLanguageServer(task.id, (msg) => {
				task.progressMsg = msg;
				this.tui?.requestRender?.();
			});

			if (res.success) {
				task.status = "done";
				task.progressMsg = res.message;
				task.binPath = res.binPath;
			} else {
				task.status = "error";
				task.progressMsg = "Failed";
				task.errorMsg = res.message;
			}
			this.tui?.requestRender?.();
		}

		this.isFinished = true;
		this.stopAnimation();
		this.tui?.requestRender?.();

		// Auto-dismiss after 2 seconds on success
		setTimeout(() => {
			if (this.isRunning) {
				this.dispose();
				this.done();
			}
		}, 2200);
	}

	async handleInput(data: string): Promise<void> {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "q") ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space")
		) {
			this.isRunning = false;
			this.dispose();
			this.done();
		}
	}

	render(width: number): string[] {
		const cardWidth = Math.min(96, Math.max(20, width - 4));
		const innerW = Math.max(1, cardWidth - 2);

		const pad = (s: string, len: number) => {
			const safe = truncateToWidth(s, len, "");
			return safe + " ".repeat(Math.max(0, len - visibleWidth(safe)));
		};

		const reset = "\x1b[0m";
		const bgCard = "\x1b[48;5;234m";
		const fgBorder = "\x1b[38;5;240m";
		const fgTitle = "\x1b[1;38;5;255m";
		const fgSubHeader = "\x1b[1;38;5;250m";
		const fgSpinner = "\x1b[1;38;2;140;210;240m"; // Pastel cyan
		const fgSuccess = "\x1b[1;38;2;155;210;170m"; // Pastel mint
		const fgError = "\x1b[1;38;5;203m"; // Soft coral red
		const fgMuted = "\x1b[38;5;245m";
		const fgDim = "\x1b[38;5;239m";

		const frame = LspDownloadModal.SPINNER_FRAMES[this.spinnerIndex];
		const row = (content: string) =>
			bgCard + fgBorder + "│" + reset + bgCard + pad(content, innerW) + fgBorder + "│" + reset;

		const cardLines: string[] = [];

		cardLines.push(bgCard + fgBorder + `╭${"─".repeat(innerW)}╮` + reset);
		cardLines.push(row(` ${fgTitle}LSP Package Manager & Downloader${reset}${bgCard}  ${fgDim}(Zero-Dependency Install)`));
		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);

		const activeCount = this.tasks.filter((t) => t.status === "downloading").length;
		const doneCount = this.tasks.filter((t) => t.status === "done").length;

		if (this.isFinished) {
			const allSuccess = this.tasks.every((t) => t.status === "done");
			const headerMsg = allSuccess
				? `${fgSuccess}✓ All ${this.tasks.length} language server(s) successfully installed!`
				: `${fgSubHeader}Installation completed (${doneCount}/${this.tasks.length} succeeded):`;
			cardLines.push(row(` ${headerMsg}`));
		} else {
			cardLines.push(row(` ${fgSpinner}${frame} Downloading & installing ${this.tasks.length} language server(s)... (${doneCount}/${this.tasks.length} completed)`));
		}

		cardLines.push(row(``));

		// Render each task row
		for (const task of this.tasks) {
			let icon = `${fgDim}•`;
			let statusColor = fgMuted;
			let lineText = "";

			if (task.status === "queued") {
				icon = `${fgDim}•`;
				statusColor = fgDim;
				lineText = `${icon} ${fgSubHeader}${task.label.padEnd(18)}${statusColor}Queued`;
			} else if (task.status === "downloading") {
				icon = `${fgSpinner}${frame}`;
				statusColor = fgSpinner;
				lineText = `${icon} ${fgTitle}${task.label.padEnd(18)}${statusColor}${task.progressMsg}`;
			} else if (task.status === "done") {
				icon = `${fgSuccess}✓`;
				statusColor = fgSuccess;
				const details = task.binPath ? `(${task.binPath})` : "Installed";
				lineText = `${icon} ${fgTitle}${task.label.padEnd(18)}${statusColor}Ready ${fgDim}${details}`;
			} else if (task.status === "error") {
				icon = `${fgError}✗`;
				statusColor = fgError;
				lineText = `${icon} ${fgTitle}${task.label.padEnd(18)}${statusColor}${task.errorMsg || "Failed"}`;
			}

			cardLines.push(row(`   ${lineText}`));
		}

		cardLines.push(row(``));
		cardLines.push(bgCard + fgBorder + `├${"─".repeat(innerW)}┤` + reset);

		const footerText = this.isFinished
			? ` ${fgDim}Press any key or Enter to continue...`
			: ` ${fgDim}Esc: Run in Background / Cancel`;
		cardLines.push(row(footerText));
		cardLines.push(bgCard + fgBorder + `╰${"─".repeat(innerW)}╯` + reset);

		const termHeight =
			this.tui?.terminal?.rows ||
			(process.stdout && process.stdout.rows ? process.stdout.rows : 24);

		const leftPad = Math.max(0, Math.floor((width - cardWidth) / 2));
		const rightPad = Math.max(0, width - cardWidth - leftPad);

		const scrim = (len: number) =>
			len <= 0 ? "" : "\x1b[48;5;232m\x1b[38;5;234m" + "░".repeat(len) + reset;

		const shadowRight = (len: number) => {
			if (len <= 0) return "";
			return "\x1b[48;5;232m\x1b[38;5;233m▌" + reset + scrim(len - 1);
		};

		const shadowBottom = (left: number, card: number, right: number) => {
			return (
				scrim(left) +
				"\x1b[48;5;232m\x1b[38;5;233m" +
				"▀".repeat(card) +
				reset +
				scrim(right)
			);
		};

		const totalCardRows = cardLines.length + 1;
		const topPad = Math.max(0, Math.floor((termHeight - totalCardRows) / 2));
		const bottomPad = Math.max(0, termHeight - totalCardRows - topPad);

		const fullLines: string[] = [];

		for (let i = 0; i < topPad; i++) {
			fullLines.push(scrim(width));
		}

		for (let i = 0; i < cardLines.length; i++) {
			const line = scrim(leftPad) + cardLines[i] + shadowRight(rightPad);
			fullLines.push(line);
		}

		fullLines.push(shadowBottom(leftPad, cardWidth, rightPad));

		for (let i = 0; i < bottomPad; i++) {
			fullLines.push(scrim(width));
		}

		return fullLines;
	}

	invalidate(): void {}
	dispose(): void {
		this.isRunning = false;
		this.stopAnimation();
	}
}
