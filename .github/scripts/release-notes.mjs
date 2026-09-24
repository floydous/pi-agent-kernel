import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tag = (process.env.GITHUB_REF_NAME || "").replace(/^v/, "");
if (!tag) throw new Error("GITHUB_REF_NAME is required");

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const start = changelog.search(new RegExp(`^## \\[${escaped}\\]`, "m"));
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${tag}`);
const rest = changelog.slice(start);
const next = rest.slice(1).search(/^## \[/m);
const section = (next < 0 ? rest : rest.slice(0, next + 1)).trim();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-kernel-release-"));
const notes = path.join(dir, "notes.md");
fs.writeFileSync(notes, `${section}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(notes);
