import * as fs from "node:fs";
import * as os from "node:os";

export interface HostEnvironmentOptions {
	platform?: string;
	arch?: string;
	osReleaseContent?: string;
	isWsl?: boolean;
}

let memoizedHostEnv: string | null = null;

function unquote(val: string): string {
	const trimmed = val.trim();
	if (trimmed.length >= 2) {
		const first = trimmed.charAt(0);
		const last = trimmed.charAt(trimmed.length - 1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			const inside = trimmed.slice(1, -1);
			return first === '"' ? inside.replace(/\\([\\"$`])/g, "$1") : inside;
		}
	}
	return trimmed;
}

export function parseOSRelease(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf("=");
		if (idx < 1) continue;
		const key = trimmed.slice(0, idx);
		if (/^[A-Z0-9_]+$/.test(key)) {
			result[key] = unquote(trimmed.slice(idx + 1));
		}
	}
	return result;
}

function getWindowsVersion(): string {
	const rel = os.release();
	const match = rel.match(/(\d+)\.(\d+)\.(\d+)/);
	if (match) {
		const build = parseInt(match[3], 10);
		return build >= 22000 ? "Windows 11" : "Windows 10";
	}
	return "Windows";
}

interface LinuxDistroInfo {
	name: string;
	id?: string;
	idLike?: string;
}

function resolveLinuxDistro(options?: HostEnvironmentOptions): LinuxDistroInfo {
	if (options?.osReleaseContent) {
		const parsed = parseOSRelease(options.osReleaseContent);
		const name = parsed.PRETTY_NAME || parsed.NAME || parsed.ID || "Linux";
		return { name, id: parsed.ID?.toLowerCase(), idLike: parsed.ID_LIKE?.toLowerCase() };
	}

	for (const p of ["/etc/os-release", "/usr/lib/os-release"]) {
		try {
			if (fs.existsSync(p)) {
				const content = fs.readFileSync(p, "utf8");
				const parsed = parseOSRelease(content);
				const name = parsed.PRETTY_NAME || parsed.NAME || parsed.ID || "Linux";
				return { name, id: parsed.ID?.toLowerCase(), idLike: parsed.ID_LIKE?.toLowerCase() };
			}
		} catch {}
	}

	return { name: "Linux" };
}

function checkIsWsl(options?: HostEnvironmentOptions): boolean {
	if (options?.isWsl !== undefined) return options.isWsl;
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		if (fs.existsSync("/proc/version")) {
			const version = fs.readFileSync("/proc/version", "utf8");
			return /microsoft|wsl/i.test(version);
		}
	} catch {}
	return false;
}

/**
 * Reset in-memory memoized host environment (useful for tests).
 */
export function resetHostEnvironmentCache(): void {
	memoizedHostEnv = null;
}

/**
 * Render concise factual host environment block.
 * Safe from prompt injection: contains only trusted OS, shell, and platform guidance.
 */
export function renderHostEnvironment(options?: HostEnvironmentOptions): string {
	if (!options && memoizedHostEnv) {
		return memoizedHostEnv;
	}

	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;
	const isWin = platform === "win32";
	const isMac = platform === "darwin";

	if (isWin) {
		const osName = getWindowsVersion();
		const lines = [
			"<host_environment>",
			`Platform: ${osName} (${platform} ${arch})`,
			"Shell: bash (Git Bash / MSYS2)",
			"Line Endings: Preserved per-file (auto-detects CRLF / LF)",
			"Execution Rules:",
			"- Terminal commands run through Git Bash: use POSIX syntax (ls, grep, cat, find, &&, 2>/dev/null).",
			"- Paths: Use forward slashes (C:/Users/...) for native Windows tools (node, cargo, python).",
			"- Python binary: invoke as 'python' ('python3' is Windows Store stub).",
			"- Non-profile PowerShell: prefer .NET ([System.Security.Cryptography.SHA256]) or certutil over autoloaded cmdlets like Get-FileHash.",
			"</host_environment>",
		];
		const result = lines.join("\n");
		if (!options) memoizedHostEnv = result;
		return result;
	}

	if (isMac) {
		const lines = [
			"<host_environment>",
			`Platform: macOS (${platform} ${arch})`,
			"Shell: bash (macOS /bin/bash v3.2)",
			"Line Endings: Preserved per-file (auto-detects CRLF / LF)",
			"Execution Rules:",
			"- Stock /bin/bash is Bash 3.2: avoid Bash 4+ features (declare -A, mapfile/readarray, ${var^^}).",
			"- BSD userland: use portable POSIX flags (e.g. sed -i '' for in-place edit, not GNU sed -i).",
			"- Python binary: invoke as 'python3' ('python' is not aliased).",
			"</host_environment>",
		];
		const result = lines.join("\n");
		if (!options) memoizedHostEnv = result;
		return result;
	}

	// Linux
	const distro = resolveLinuxDistro(options);
	const isWsl = checkIsWsl(options);
	const hostDisplay = isWsl ? `${distro.name} on WSL` : distro.name;

	const rules: string[] = [];
	const id = distro.id || "";
	const idLike = distro.idLike || "";

	if (id === "alpine") {
		rules.push("- Alpine Linux (musl libc): package manager is 'apk'; glibc-linked binaries are incompatible without gcompat.");
	} else if (id === "arch") {
		rules.push("- Arch Linux (glibc): package manager is 'pacman'.");
	} else if (id === "fedora" || id === "rhel" || id === "centos" || idLike.includes("fedora") || idLike.includes("rhel")) {
		rules.push("- Fedora/RHEL Linux (glibc): package manager is 'dnf' / 'yum'.");
	} else if (id === "debian" || id === "ubuntu" || idLike.includes("debian")) {
		rules.push("- Debian/Ubuntu Linux (glibc): package manager is 'apt'.");
	} else {
		rules.push("- Standard Linux environment (glibc): use standard POSIX syntax and paths.");
	}
	rules.push("- Python binary: invoke as 'python3' ('python' is not aliased).");

	const lines = [
		"<host_environment>",
		`Platform: ${hostDisplay} (${platform} ${arch})`,
		"Shell: bash",
		"Line Endings: Preserved per-file (auto-detects CRLF / LF)",
		"Execution Rules:",
		...rules,
		"</host_environment>",
	];
	const result = lines.join("\n");
	if (!options) memoizedHostEnv = result;
	return result;
}
