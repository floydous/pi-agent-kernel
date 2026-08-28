/**
 * Lightweight, zero-dependency TOML parser and serializer
 * Supports:
 * - Table headers ([table], [table.sub])
 * - Strings (single and double quoted, multiline)
 * - Numbers (integers, floats)
 * - Booleans (true, false)
 * - Arrays (inline [1, 2, 3] and multi-line)
 * - Comments (# comment)
 */

export type TomlValue =
	| string
	| number
	| boolean
	| TomlValue[]
	| { [key: string]: TomlValue };

export function parseToml(tomlStr: string): Record<string, TomlValue> {
	const root: Record<string, TomlValue> = {};
	let currentTable: Record<string, TomlValue> = root;

	const lines = tomlStr.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trim();

		// Skip empty lines and full comments
		if (!line || line.startsWith("#")) {
			continue;
		}

		// Table header: [table] or [table.sub]
		if (line.startsWith("[") && line.endsWith("]") && !line.startsWith("[[")) {
			const tableName = line.slice(1, -1).trim();
			const parts = tableName.split(".").map((p) => p.trim());
			let cursor = root;
			for (const part of parts) {
				const existing = cursor[part];
				if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
					cursor[part] = {};
				}
				cursor = cursor[part] as Record<string, TomlValue>;
			}
			currentTable = cursor;
			continue;
		}

		// Key-value pair: key = value
		const eqIndex = line.indexOf("=");
		if (eqIndex === -1) continue;

		const key = line.slice(0, eqIndex).trim();
		let rawValue = line.slice(eqIndex + 1).trim();

		// Handle multi-line arrays if open bracket without close bracket
		if (rawValue.startsWith("[") && !rawValue.endsWith("]")) {
			let combined = rawValue;
			while (i + 1 < lines.length && !combined.includes("]")) {
				i++;
				combined += " " + lines[i].trim();
			}
			rawValue = combined;
		}

		// Strip inline comment if not inside quote
		rawValue = stripInlineComment(rawValue);

		currentTable[key] = parseTomlValue(rawValue);
	}

	return root;
}

function stripInlineComment(valStr: string): string {
	let inQuote = false;
	let quoteChar = "";
	for (let i = 0; i < valStr.length; i++) {
		const ch = valStr[i];
		if ((ch === '"' || ch === "'") && (i === 0 || valStr[i - 1] !== "\\")) {
			if (!inQuote) {
				inQuote = true;
				quoteChar = ch;
			} else if (quoteChar === ch) {
				inQuote = false;
			}
		} else if (ch === "#" && !inQuote) {
			return valStr.slice(0, i).trim();
		}
	}
	return valStr.trim();
}

function parseTomlValue(valStr: string): TomlValue {
	const trimmed = valStr.trim();

	// Boolean
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;

	// String (double quoted)
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return trimmed
			.slice(1, -1)
			.replace(/\\"/g, '"')
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\\\/g, "\\");
	}

	// String (single quoted)
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed.slice(1, -1);
	}

	// Array
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return [];
		return splitTomlArray(inner).map(parseTomlValue);
	}

	// Number (Integer or Float)
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return trimmed.includes(".") ? parseFloat(trimmed) : parseInt(trimmed, 10);
	}

	// Fallback unquoted string
	return trimmed;
}

function splitTomlArray(arrayContent: string): string[] {
	const items: string[] = [];
	let current = "";
	let inQuote = false;
	let quoteChar = "";
	let depth = 0;

	for (let i = 0; i < arrayContent.length; i++) {
		const ch = arrayContent[i];

		if ((ch === '"' || ch === "'") && (i === 0 || arrayContent[i - 1] !== "\\")) {
			if (!inQuote) {
				inQuote = true;
				quoteChar = ch;
			} else if (quoteChar === ch) {
				inQuote = false;
			}
			current += ch;
		} else if (ch === "[" && !inQuote) {
			depth++;
			current += ch;
		} else if (ch === "]" && !inQuote) {
			depth--;
			current += ch;
		} else if (ch === "," && !inQuote && depth === 0) {
			if (current.trim()) {
				items.push(current.trim());
			}
			current = "";
		} else {
			current += ch;
		}
	}

	if (current.trim()) {
		items.push(current.trim());
	}

	return items;
}

export function stringifyToml(
	obj: Record<string, TomlValue>,
	prefix = "",
): string {
	let out = "";
	const topLevelKeys: string[] = [];
	const tables: Array<{ key: string; val: Record<string, TomlValue> }> = [];

	for (const [k, v] of Object.entries(obj)) {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			tables.push({ key: k, val: v });
		} else {
			topLevelKeys.push(k);
		}
	}

	// Top level keys first
	for (const k of topLevelKeys) {
		out += `${k} = ${formatTomlValue(obj[k])}\n`;
	}

	// Tables
	for (const table of tables) {
		const tableHeader = prefix ? `${prefix}.${table.key}` : table.key;
		if (out.length > 0 && !out.endsWith("\n\n")) {
			out += "\n";
		}
		out += `[${tableHeader}]\n`;

		const subKeys: string[] = [];
		const subTables: Array<{ key: string; val: Record<string, TomlValue> }> = [];

		for (const [sk, sv] of Object.entries(table.val)) {
			if (sv && typeof sv === "object" && !Array.isArray(sv)) {
				subTables.push({ key: sk, val: sv });
			} else {
				subKeys.push(sk);
			}
		}

		for (const sk of subKeys) {
			out += `${sk} = ${formatTomlValue(table.val[sk])}\n`;
		}

		for (const subTable of subTables) {
			out += "\n" + stringifyToml({ [subTable.key]: subTable.val }, tableHeader);
		}
	}

	return out;
}

function formatTomlValue(val: TomlValue): string {
	if (typeof val === "boolean") return val ? "true" : "false";
	if (typeof val === "number") return String(val);
	if (typeof val === "string") {
		return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
	}
	if (Array.isArray(val)) {
		const formatted = val.map(formatTomlValue);
		return `[${formatted.join(", ")}]`;
	}
	if (val === null || val === undefined) return '""';
	return `"${String(val)}"`;
}
