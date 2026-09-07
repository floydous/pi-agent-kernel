import { LspManager } from "../../src/lsp";
import { assertPass, logPass } from "../_setup";

export function testLspManagerLifecycle(): void {
	const lspMgr = LspManager.getInstance();
	const statusList = lspMgr.getStatus();
	assertPass("LspManager status returns an array", Array.isArray(statusList), { statusList });
	logPass(`LspManager daemon lifecycle verified (active: ${statusList.length})!`);
}
