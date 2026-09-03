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
	invalidateSearchFile?: (cwd: string, filePath: string) => void;
}

export interface SearchDeps extends SessionDeps {
 /** Lazily create/access the workspace hybrid search index singleton. */
 getSearchIndex: (
  cwd: string,
 ) => import("../retrieval/search_index").HybridSearchIndex;
}
