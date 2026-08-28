/**
 * Debug-gated sink for intentionally best-effort catch blocks.
 *
 * Many operations in this extension are advisory (cache cleanup, optional
 * parsing, UI polish) and deliberately swallow failures. This helper keeps
 * them silent by default while making them observable when debugging:
 * set PI_KERNEL_DEBUG=1 to surface swallowed errors on stderr.
 */
export function kernelDebug(err: unknown): void {
 if (!process.env.PI_KERNEL_DEBUG) return;
 console.error(
  "[agent-kernel]",
  err instanceof Error ? err.stack || err.message : err,
 );
}
