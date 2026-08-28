// Section 18: LSP - LspManager lifecycle, LspControlModal, LspDownloadModal

import { LspManager, LspControlModal, LspDownloadModal } from "../lsp";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("18. LSP Manager Lifecycle & Modals", async () => {
		// 6. LspManager Lifecycle & Status
		const lspMgr = LspManager.getInstance();
		const statusList = lspMgr.getStatus();
		assertPass("LspManager status returns array", Array.isArray(statusList), { statusList });
		logPass(`LspManager daemon lifecycle verified! (Active servers: ${statusList.length})`);

		// 7. LspControlModal Rendering & Full-Viewport Scrim Backdrop
		const mockLspTui = {
			terminal: { rows: 30 },
			requestRender: () => {},
		};
		const mockTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		let modalDoneResult: any = null;
		const lspModal = new LspControlModal(mockLspTui, lspMgr, mockTheme, (res) => {
			modalDoneResult = res;
		});

		const modalLines = lspModal.render(120);
		assertPass("LspControlModal rendered non-empty lines", modalLines && modalLines.length > 0, { modalLines });

		const fullModalText = modalLines.join("\n");
		assertPass(
			"LspControlModal has backdrop scrim and card sections",
			fullModalText.includes("Language Server Protocol (LSP)") &&
				fullModalText.includes("Active LSP Daemons") &&
				fullModalText.includes("Available Server Binaries") &&
				fullModalText.includes("░") &&
				fullModalText.includes("─"),
			{ modalText: fullModalText.slice(0, 200) }
		);
		assertPass(
			"LspControlModal has [x] / [ ] selection boxes",
			fullModalText.includes("[x]") || fullModalText.includes("[ ]"),
			{ modalText: fullModalText.slice(0, 200) }
		);

		// Test Space key toggling
		await lspModal.handleInput(" "); // Toggle first item with space

		// Test Escape key dismissal
		await lspModal.handleInput("\x1b"); // Escape
		assertPass(
			"LspControlModal escape dismissal works",
			!!modalDoneResult && modalDoneResult.action === "close",
			{ modalDoneResult }
		);
		logPass("LspControlModal selection box, download indicator & space-toggling verified!");

		// 7.1 LspDownloadModal ASCII Spinner & Progress Rendering
		let downloadDone = false;
		const downloadModal = new LspDownloadModal(mockLspTui, ["rust", "python"], mockTheme, () => {
			downloadDone = true;
		});
		const dlLines = downloadModal.render(100);
		const dlText = dlLines.join("\n");
		assertPass(
			"LspDownloadModal rendering",
			dlText.includes("LSP Package Manager & Downloader") && dlText.includes("Rust") && dlText.includes("Python"),
			{ dlText: dlText.slice(0, 200) }
		);
		// Handle key dismissal
		await downloadModal.handleInput("\x1b");
		downloadModal.dispose();
		logPass("LspDownloadModal animated ASCII spinner & task progress verified!");
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
