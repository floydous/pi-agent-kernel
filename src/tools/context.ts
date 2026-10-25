/**
 * Shared dependencies injected from the kernel entry point into tool modules.
 * Keeps tool registration pure: no hidden singletons, everything flows through
 * these explicit contracts.
 */
export interface SessionDeps {
 /** Resolve stable session id for epistemic-guard bookkeeping. */
 getSessionId: (ctx: any) => string;
 /** Load runtime settings for the active workspace. */
	getConfig?: (cwd: string) => import("../config").KernelConfig;
	/** Mark a successfully mutated file stale in the workspace index. */
	invalidateSearchFile?: (cwd: string, filePath: string) => void | Promise<void>;
}

/**
 * Whether the opt-in tools (`get_repo_map`, `ast_search`) are registered for this
 * workspace. Single source of truth: `src/index.ts` gates registration on this, and user-facing
 * tool hints consult it so they never recommend a tool the model cannot actually call.
 */
export function speculativeToolsEnabled(
	getConfig: ((cwd: string) => import("../config").KernelConfig) | undefined,
	cwd: string,
): boolean {
	const flag = process.env.PI_ENABLE_ALL_RETRIEVAL_TOOLS;
	if (flag === "1" || flag === "true") return true;
	return getConfig?.(cwd)?.retrieval?.enable_tools === true;
}

export interface SearchDeps extends SessionDeps {
 /** Lazily create/access the workspace hybrid search index singleton. */
 getSearchIndex: (
  cwd: string,
 ) => import("../retrieval/search_index").HybridSearchIndex;
}
