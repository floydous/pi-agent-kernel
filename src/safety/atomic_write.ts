import * as fs from "node:fs";
import { kernelDebug } from "./kernel_debug";

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * destination. A plain writeFileSync can leave a truncated/corrupt JSON store
 * behind if the process dies mid-write; with tmp+rename the destination either
 * holds the old complete file or the new complete file, never a partial one.
 */
export function writeFileSyncAtomic(
	filePath: string,
	data: string | Buffer,
): void {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch (cleanupErr) {
			kernelDebug(cleanupErr);
		}
		throw err;
	}
}
