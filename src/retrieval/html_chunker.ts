import * as path from "node:path";
import * as fs from "node:fs";
import { TreeSitterEngine } from "./tree_sitter_engine";
import { computeHash, type CodeChunk } from "./search_chunker";
import { kernelDebug } from "../safety/kernel_debug";

export interface TreeSitterNode {
	type: string;
	text: string;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	parent?: TreeSitterNode | null;
	namedChildCount?: number;
	namedChildren?: TreeSitterNode[];
	namedChild: (index: number) => TreeSitterNode | null;
}

export interface TreeSitterTree {
	rootNode: TreeSitterNode;
	delete(): void;
}

export interface HtmlMetadata {
	tag: string;
	id?: string;
	classes: string[];
	role?: string;
	ariaLabel?: string;
	ariaLabelledBy?: string;
	placeholder?: string;
	name?: string;
	type?: string;
	for?: string;
}

export interface HtmlGroup {
	file: string;
	node: TreeSitterNode;
	metadata: HtmlMetadata;
	symbolName: string;
	startLine: number;
	endLine: number;
	content: string;
	breadcrumb: string;
	details: string;
	visibleText: string;
}

export interface ParsedHtml {
	file: string;
	lines: string[];
	root: TreeSitterNode;
	tree: TreeSitterTree;
	bodyStartLine: number;
	bodyEndLine: number;
	rawRanges: Array<{ startLine: number; endLine: number; type: "style" | "script" }>;
}

export interface GroupChunkerOptions {
	minimumLines: number;
	maximumLines: number;
	rawBoundaryMinimumLines: number;
}

export const DEFAULT_HTML_CHUNKER_OPTIONS: GroupChunkerOptions = {
	minimumLines: 6,
	maximumLines: 70,
	rawBoundaryMinimumLines: 3,
};

const SEMANTIC_TAGS = new Set([
	"header", "nav", "main", "section", "article", "aside", "footer", "form", "dialog", "template", "table", "thead", "tbody"
]);
const SHORT_SEMANTIC_GROUPS = new Set([
	"header", "nav", "footer", "form", "dialog", "template"
]);
const INTERACTIVE_TAGS = new Set([
	"button", "input", "select", "textarea", "a", "label"
]);
const GENERIC_CLASSES = new Set([
	"container", "content", "wrapper", "row", "col", "grid", "panel", "body", "header", "footer", "main", "section", "tab"
]);
const MIN_INTERACTIVE_GROUP_LINES = 3;

function range(node: TreeSitterNode): { startLine: number; endLine: number } {
	const startLine = node.startPosition.row + 1;
	const endLine = node.endPosition.column === 0 ? node.endPosition.row : node.endPosition.row + 1;
	return { startLine, endLine: Math.max(startLine, endLine) };
}

function text(node: TreeSitterNode | null | undefined): string {
	return node?.text || "";
}

function elementChildren(node: TreeSitterNode | null | undefined): TreeSitterNode[] {
	if (!node) return [];
	const count = node.namedChildCount ?? 0;
	const children: TreeSitterNode[] = [];
	for (let i = 0; i < count; i++) {
		const child = node.namedChild(i);
		if (child && (child.type === "element" || child.type === "script_element" || child.type === "style_element")) {
			children.push(child);
		}
	}
	return children;
}

function attr(attribute: TreeSitterNode): [string, string] | null {
	const nameNode = attribute.namedChildren?.find((child) => child.type === "attribute_name");
	const valueNode = attribute.namedChildren?.find((child) => child.type === "quoted_attribute_value" || child.type === "attribute_value");
	const name = text(nameNode).toLowerCase();
	if (!name) return null;
	const value = text(valueNode).trim().replace(/^['"]|['"]$/g, "");
	return [name, value];
}

export function metadata(node: TreeSitterNode): HtmlMetadata | null {
	if (node.type !== "element" && node.type !== "script_element" && node.type !== "style_element") return null;
	const startTag = node.namedChildren?.find((child) => child.type === "start_tag" || child.type === "self_closing_tag");
	const tag = text(startTag?.namedChildren?.find((child) => child.type === "tag_name")).toLowerCase();
	if (!tag) return null;
	const values = new Map<string, string>();
	for (const child of startTag?.namedChildren?.filter((item) => item.type === "attribute") ?? []) {
		const pair = attr(child);
		if (pair) values.set(pair[0], pair[1]);
	}
	return {
		tag,
		id: values.get("id") || undefined,
		classes: (values.get("class") || "").split(/\s+/).filter(Boolean),
		role: values.get("role") || undefined,
		ariaLabel: values.get("aria-label") || undefined,
		ariaLabelledBy: values.get("aria-labelledby") || undefined,
		placeholder: values.get("placeholder") || undefined,
		name: values.get("name") || undefined,
		type: values.get("type") || undefined,
		for: values.get("for") || undefined,
	};
}

export function identity(value: HtmlMetadata): string {
	const classPart = value.classes.filter((name) => !GENERIC_CLASSES.has(name)).slice(0, 2).map((name) => `.${name}`).join("");
	const idPart = value.id ? `#${value.id}` : "";
	const rolePart = !idPart && value.role ? `[role=${value.role}]` : "";
	return `${value.tag}${idPart}${classPart}${rolePart}`;
}

function isInteractive(value: HtmlMetadata): boolean {
	return INTERACTIVE_TAGS.has(value.tag);
}

function sourceLines(node: TreeSitterNode): number {
	const span = range(node);
	return span.endLine - span.startLine + 1;
}

function hasLargeRawDescendant(node: TreeSitterNode, options: GroupChunkerOptions): boolean {
	const visit = (current: TreeSitterNode): boolean => {
		if ((current.type === "style_element" || current.type === "script_element") && sourceLines(current) >= options.rawBoundaryMinimumLines) return true;
		return elementChildren(current).some(visit);
	};
	return elementChildren(node).some(visit);
}

function descendantInteractiveCount(node: TreeSitterNode): number {
	let count = 0;
	const visit = (current: TreeSitterNode) => {
		const value = metadata(current);
		if (value && isInteractive(value)) count++;
		for (const child of elementChildren(current)) visit(child);
	};
	visit(node);
	return count;
}

function hasStrongDescendantIdentity(node: TreeSitterNode): boolean {
	let found = false;
	const visit = (current: TreeSitterNode) => {
		const value = metadata(current);
		if (value && (Boolean(value.id) || Boolean(value.role) || Boolean(value.ariaLabel) || Boolean(value.ariaLabelledBy))) found = true;
		for (const child of elementChildren(current)) visit(child);
	};
	visit(node);
	return found;
}

function isGroupCandidate(node: TreeSitterNode, value: HtmlMetadata, options: GroupChunkerOptions): boolean {
	if (["html", "body", "style", "script"].includes(value.tag) || isInteractive(value)) return false;
	const lines = sourceLines(node);
	const hasInteractiveOrIdentity = Boolean(value.id) || Boolean(value.role) || Boolean(value.ariaLabel) || Boolean(value.ariaLabelledBy) || descendantInteractiveCount(node) > 0 || hasStrongDescendantIdentity(node);
	if (hasInteractiveOrIdentity && lines >= MIN_INTERACTIVE_GROUP_LINES) return true;
	if (SEMANTIC_TAGS.has(value.tag)) return lines >= options.minimumLines || SHORT_SEMANTIC_GROUPS.has(value.tag);
	return false;
}

export function visibleText(node: TreeSitterNode): string {
	const parts: string[] = [];
	const visit = (current: TreeSitterNode) => {
		if (current.type === "style_element" || current.type === "script_element" || current.type === "raw_text") return;
		if (current.type === "text") {
			parts.push(text(current));
			return;
		}
		const count = current.namedChildCount ?? 0;
		for (let i = 0; i < count; i++) {
			const child = current.namedChild(i);
			if (child) visit(child);
		}
	};
	visit(node);
	return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 700);
}

function controlDetails(node: TreeSitterNode): string[] {
	const details = new Set<string>();
	const visit = (current: TreeSitterNode) => {
		const value = metadata(current);
		if (value && isInteractive(value)) {
			const tokens = [
				identity(value),
				value.id ? `id ${value.id}` : "",
				value.role ? `role ${value.role}` : "",
				value.ariaLabel ? `label ${value.ariaLabel}` : "",
				value.placeholder ? `placeholder ${value.placeholder}` : "",
				value.type ? `type ${value.type}` : "",
				value.for ? `for ${value.for}` : "",
			].filter(Boolean).join("; ");
			if (tokens) details.add(tokens);
		}
		for (const child of elementChildren(current)) visit(child);
	};
	visit(node);
	return [...details].sort((a, b) => a.localeCompare(b));
}

export function breadcrumb(node: TreeSitterNode, file: string): string {
	const parts: string[] = [];
	let current: TreeSitterNode | null | undefined = node;
	while (current) {
		const value = metadata(current);
		if (value && !["html", "body", "style", "script"].includes(value.tag)) parts.push(identity(value));
		current = current.parent;
	}
	const reversed: string[] = [];
	for (let i = parts.length - 1; i >= 0; i--) {
		reversed.push(parts[i]);
	}
	return `HTML: ${file}${reversed.length ? ` > ${reversed.join(" > ")}` : ""}`;
}

function groupDetails(node: TreeSitterNode, value: HtmlMetadata): string {
	return [
		`tag ${value.tag}`,
		value.id ? `id ${value.id}` : "",
		value.classes.length ? `classes ${value.classes.join(" ")}` : "",
		value.role ? `role ${value.role}` : "",
		value.ariaLabel ? `label ${value.ariaLabel}` : "",
		value.ariaLabelledBy ? `labelledby ${value.ariaLabelledBy}` : "",
		visibleText(node) ? `text ${visibleText(node)}` : "",
		...controlDetails(node),
	].filter(Boolean).join("; ");
}

function hasMultipleChildLandmarks(node: TreeSitterNode, options: GroupChunkerOptions): boolean {
	const children = elementChildren(node);
	let count = 0;
	for (const child of children) {
		const m = metadata(child);
		if (!m || isInteractive(m)) continue;
		const isLandmark = SEMANTIC_TAGS.has(m.tag) && (sourceLines(child) >= options.minimumLines || SHORT_SEMANTIC_GROUPS.has(m.tag));
		const isInteractiveBlock = (descendantInteractiveCount(child) > 0 || hasStrongDescendantIdentity(child)) && sourceLines(child) >= MIN_INTERACTIVE_GROUP_LINES;
		if (isLandmark || isInteractiveBlock) {
			count++;
			if (count >= 2) return true;
		}
	}
	return false;
}

function fallbackPartition(node: TreeSitterNode, parsed: ParsedHtml, options: GroupChunkerOptions): HtmlGroup[] {
	const children = elementChildren(node).filter((c) => c.type !== "style_element" && c.type !== "script_element");
	const val = metadata(node) || { tag: node.type || "element", classes: [] };
	const trail = breadcrumb(node, parsed.file);

	if (children.length === 0) {
		const { startLine, endLine } = range(node);
		const groups: HtmlGroup[] = [];
		const step = options.maximumLines;
		for (let s = startLine; s <= endLine; s += step) {
			const e = Math.min(endLine, s + step - 1);
			const content = parsed.lines.slice(s - 1, e).join("\n");
			const partIdentity = `${identity(val)}:lines-${s}-${e}`;
			groups.push({
				file: parsed.file,
				node,
				metadata: val,
				symbolName: partIdentity,
				startLine: s,
				endLine: e,
				content,
				breadcrumb: trail,
				details: `tag ${val.tag}; part lines ${s}-${e}; ${visibleText(node).slice(0, 200)}`,
				visibleText: visibleText(node).slice(0, 300),
			});
		}
		return groups;
	}

	const groups: HtmlGroup[] = [];
	let currentStart = -1;
	let currentEnd = -1;
	let currentKids: TreeSitterNode[] = [];

	const flush = () => {
		if (currentStart === -1 || currentEnd === -1) return;
		const content = parsed.lines.slice(currentStart - 1, currentEnd).join("\n");
		const partName = `${identity(val)}:part-${currentStart}-${currentEnd}`;
		const kidText = currentKids.map((k) => visibleText(k)).filter(Boolean).join(" ").slice(0, 300);
		groups.push({
			file: parsed.file,
			node,
			metadata: val,
			symbolName: partName,
			startLine: currentStart,
			endLine: currentEnd,
			content,
			breadcrumb: trail,
			details: `tag ${val.tag}; part lines ${currentStart}-${currentEnd}; ${kidText}`,
			visibleText: kidText,
		});
		currentStart = -1;
		currentEnd = -1;
		currentKids = [];
	};

	for (const child of children) {
		const cSpan = range(child);
		const cLines = cSpan.endLine - cSpan.startLine + 1;
		if (cLines > options.maximumLines) {
			flush();
			groups.push(...fallbackPartition(child, parsed, options));
			continue;
		}

		if (currentStart === -1) {
			currentStart = cSpan.startLine;
			currentEnd = cSpan.endLine;
			currentKids.push(child);
		} else {
			const candidateEnd = Math.max(currentEnd, cSpan.endLine);
			if (candidateEnd - currentStart + 1 > options.maximumLines) {
				flush();
				currentStart = cSpan.startLine;
				currentEnd = cSpan.endLine;
				currentKids.push(child);
			} else {
				currentEnd = candidateEnd;
				currentKids.push(child);
			}
		}
	}
	flush();
	return groups;
}

export function selectGroups(node: TreeSitterNode, parsed: ParsedHtml, options: GroupChunkerOptions = DEFAULT_HTML_CHUNKER_OPTIONS): HtmlGroup[] {
	const value = metadata(node);
	if (!value || !isGroupCandidate(node, value, options)) {
		return elementChildren(node).flatMap((child) => selectGroups(child, parsed, options));
	}

	const isContainer = ["div", "main", "article"].includes(value.tag);
	const shouldSplitGenericWrapper = isContainer && hasMultipleChildLandmarks(node, options);

	if (!shouldSplitGenericWrapper && sourceLines(node) <= options.maximumLines && !hasLargeRawDescendant(node, options)) {
		const { startLine, endLine } = range(node);
		return [{
			file: parsed.file,
			node,
			metadata: value,
			symbolName: identity(value),
			startLine,
			endLine,
			content: parsed.lines.slice(startLine - 1, endLine).join("\n"),
			breadcrumb: breadcrumb(node, parsed.file),
			details: groupDetails(node, value),
			visibleText: visibleText(node),
		}];
	}
	// Parent suppression: a large or raw-boundary parent is metadata only. Its
	// eligible children inherit that context through their breadcrumbs.
	const childGroups = elementChildren(node).flatMap((child) => selectGroups(child, parsed, options));
	if (childGroups.length > 0) {
		return childGroups;
	}

	// Fallback for oversized nodes with no eligible children:
	// Do not drop the subtree! Partition its children or lines into <= maximumLines chunks.
	if (sourceLines(node) > options.maximumLines) {
		return fallbackPartition(node, parsed, options);
	}

	return [];
}

export function rawRegions(root: TreeSitterNode): Array<{ startLine: number; endLine: number; type: "style" | "script" }> {
	const regions: Array<{ startLine: number; endLine: number; type: "style" | "script" }> = [];
	const visit = (node: TreeSitterNode) => {
		if (node.type === "style_element" || node.type === "script_element") {
			regions.push({ ...range(node), type: node.type === "style_element" ? "style" : "script" });
		}
		for (const child of elementChildren(node)) visit(child);
	};
	visit(root);
	return regions;
}

/**
 * Chunk a single HTML file into logical, syntax-bounded DOM chunks.
 */
export function chunkHtmlFile(
	rootDir: string,
	filePath: string,
	content?: string,
	options: GroupChunkerOptions = DEFAULT_HTML_CHUNKER_OPTIONS,
): CodeChunk[] {
	const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
	const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");

	let fileContent = content;
	if (fileContent === undefined) {
		try {
			fileContent = fs.readFileSync(absPath, "utf8");
		} catch {
			return [];
		}
	}

	const lines = fileContent.split(/\r?\n/);
	if (lines.length === 0) return [];

	const ext = path.extname(absPath).toLowerCase();
	const parser = TreeSitterEngine.getInstance().getParser(ext);

	if (!parser) {
		const hash = computeHash(fileContent);
		return [{
			id: `${relPath}:1-${lines.length}`,
			filePath: relPath,
			absolutePath: absPath,
			startLine: 1,
			endLine: lines.length,
			symbolName: path.basename(relPath),
			kind: "file",
			signature: `HTML file: ${path.basename(relPath)}`,
			breadcrumb: `HTML: ${relPath}`,
			content: fileContent,
			textForEmbedding: `HTML: ${relPath}\n${fileContent.slice(0, 1500)}`,
			hash,
		}];
	}

	let tree: TreeSitterTree | null = null;
	try {
		tree = parser.parse(fileContent);
		if (!tree?.rootNode) return [];

		let bodyNode: TreeSitterNode | null = null;
		const findBody = (node: TreeSitterNode) => {
			const val = metadata(node);
			if (val?.tag === "body") bodyNode = node;
			for (const child of elementChildren(node)) findBody(child);
		};
		findBody(tree.rootNode);
		const bodyRange = bodyNode ? range(bodyNode) : { startLine: 1, endLine: lines.length };

		const parsed: ParsedHtml = {
			file: relPath,
			lines,
			root: tree.rootNode,
			tree,
			bodyStartLine: bodyRange.startLine,
			bodyEndLine: bodyRange.endLine,
			rawRanges: rawRegions(tree.rootNode),
		};

		const groups = selectGroups(tree.rootNode, parsed, options);
		if (groups.length === 0) {
			const hash = computeHash(fileContent);
			return [{
				id: `${relPath}:1-${lines.length}`,
				filePath: relPath,
				absolutePath: absPath,
				startLine: 1,
				endLine: lines.length,
				symbolName: path.basename(relPath),
				kind: "file",
				signature: `HTML file: ${path.basename(relPath)}`,
				breadcrumb: `HTML: ${relPath}`,
				content: fileContent,
				textForEmbedding: `HTML: ${relPath}\n${fileContent.slice(0, 1500)}`,
				hash,
			}];
		}

		return groups.map((g) => ({
			id: `${relPath}:${g.startLine}-${g.endLine}#${g.symbolName}`,
			filePath: relPath,
			absolutePath: absPath,
			startLine: g.startLine,
			endLine: g.endLine,
			symbolName: g.symbolName,
			kind: "html",
			signature: g.details,
			breadcrumb: g.breadcrumb,
			content: g.content,
			textForEmbedding: `${g.breadcrumb}\n${g.details}\n${g.content.slice(0, 1500)}`,
			hash: computeHash(g.content),
		}));
	} catch (e) {
		kernelDebug(`Error chunking HTML file ${relPath}: ${e}`);
		return [];
	} finally {
		tree?.delete();
	}
}
