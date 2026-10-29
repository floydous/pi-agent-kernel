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
 * pi flags a tool result as an error only when `execute` throws; a returned `isError` is dropped. Kernel tools return
 * their failures, so copy the flag into `details.isError`, where the kernel's tool_result hook restores it.
 */
export function markReturnedErrors<T extends { execute: (...args: any[]) => Promise<any> }>(tool: T): T {
	const execute = tool.execute;
	return {
		...tool,
		async execute(...args: any[]) {
			const result = await execute.apply(tool, args);
			return result?.isError === true ? { ...result, details: { ...(result.details ?? {}), isError: true } } : result;
		},
	};
}

export interface SearchDeps extends SessionDeps {
 /** Lazily create/access the workspace hybrid search index singleton. */
 getSearchIndex: (
  cwd: string,
 ) => import("../retrieval/search_index").HybridSearchIndex;
}
