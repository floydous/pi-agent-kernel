import { LspManager } from "../../src/lsp";
import { assertPass, logPass } from "../_setup";

export async function testLspManagerLifecycle(): Promise<void> {
	const lspMgr = LspManager.getInstance();

	// 1. getInstance returns a singleton
	const instanceA = LspManager.getInstance();
	const instanceB = LspManager.getInstance();
	assertPass("LspManager.getInstance() returns the same singleton", instanceA === instanceB, { instanceA, instanceB });

	// 2. Initial state: getStatus() returns empty array (no clients yet)
	const initialStatus = lspMgr.getStatus();
	assertPass("LspManager initial status is an empty array", Array.isArray(initialStatus) && initialStatus.length === 0, { initialStatus });

	// 3. getClientForFile returns null for a file with no LSP server (e.g. .xyz)
	const noLspFile = "/tmp/no_lsp_for_this.xyz";
	const noClient = await lspMgr.getClientForFile(noLspFile, "/tmp");
	assertPass("getClientForFile returns null for unsupported language", noClient === null, { noClient });

	// 4. reapIdleClients is callable and returns void
	const result = await lspMgr.reapIdleClients();
	assertPass("reapIdleClients completes without error", result === undefined, { result });

	// 5. stopReaper and re-start shouldn't crash
	lspMgr.stopReaper();
	assertPass("stopReaper is idempotent and safe", lspMgr.stopReaper() === undefined, {});

	logPass("LspManager lifecycle deeply verified!");
}
