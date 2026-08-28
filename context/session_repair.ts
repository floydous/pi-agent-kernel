import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getPiHomeDir } from "../config";

/**
 * Sanitizes and repairs session JSONL files in ~/.pi/agent/sessions/
 * Ensures that any compaction, branch_summary, or message entry with a partial
 * usage object has a valid `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }`
 * to prevent uncaught TypeErrors in Pi's TUI footer renderer (usage-totals.js:15).
 */
export function sanitizeSessionFiles(agentDir?: string): { repairedFiles: number; repairedEntries: number } {
	let repairedFiles = 0;
	let repairedEntries = 0;

	try {
		const baseAgentDir = agentDir || path.join(getPiHomeDir(), "agent");
		const sessionsDir = path.join(baseAgentDir, "sessions");

		if (!fs.existsSync(sessionsDir)) {
			return { repairedFiles: 0, repairedEntries: 0 };
		}

		const sessionFolders = fs.readdirSync(sessionsDir);

		for (const folder of sessionFolders) {
			const folderPath = path.join(sessionsDir, folder);
			if (!fs.statSync(folderPath).isDirectory()) continue;

			const files = fs.readdirSync(folderPath);
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;

				const filePath = path.join(folderPath, file);
				try {
					const content = fs.readFileSync(filePath, "utf8");
					const lines = content.split("\n");
					let fileModified = false;

					const repairedLines = lines.map((line) => {
						if (!line.trim()) return line;
						try {
							const entry = JSON.parse(line);
							let entryModified = false;

							// Check compaction / branch_summary usage
							if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
								if (!entry.usage.cost || typeof entry.usage.cost.total !== "number") {
									entry.usage.cost = {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									};
									entryModified = true;
								}
							}

							// Check message usage
							if (entry.type === "message" && entry.message && entry.message.usage) {
								if (!entry.message.usage.cost || typeof entry.message.usage.cost.total !== "number") {
									entry.message.usage.cost = {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									};
									entryModified = true;
								}
							}

							if (entryModified) {
								fileModified = true;
								repairedEntries++;
								return JSON.stringify(entry);
							}
						} catch (e) {
							// Ignore unparseable lines
						}
						return line;
					});

					if (fileModified) {
						fs.writeFileSync(filePath, repairedLines.join("\n"), "utf8");
						repairedFiles++;
					}
				} catch (err) {
					// Ignore individual file read errors
				}
			}
		}
	} catch (err) {
		// Ignore top-level directory errors
	}

	return { repairedFiles, repairedEntries };
}
