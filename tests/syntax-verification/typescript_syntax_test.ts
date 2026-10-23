import * as fs from "node:fs";
import { checkSyntax } from "../../src/editing/syntax-verify";
import { createPolyglotWorkspace, assertPass, logPass } from "../_setup";

export function testTypescriptSyntax(): void {
	const ws = createPolyglotWorkspace("syntax_ts_");
	try {
		const tsPath = `${ws.tempDir}/src/app.ts`;
		const original = fs.readFileSync(tsPath, "utf8");

		const validSyntax = checkSyntax(tsPath);
		assertPass("TypeScript valid syntax returns valid=true", validSyntax.valid === true, { validSyntax });

		// Introduce a TypeScript syntax error: missing semicolon and closing brace
		fs.writeFileSync(tsPath, "export class Broken { public badMethod() {", "utf8");
		const brokenSyntax = checkSyntax(tsPath);
		assertPass("TypeScript broken syntax is detected as invalid", brokenSyntax.valid === false, { brokenSyntax });

		// Restore
		fs.writeFileSync(tsPath, original, "utf8");

		// JSX / TSX validation tests
		const tsxPath = `${ws.tempDir}/src/App.tsx`;
		const validTsx = `
import React, { StrictMode } from 'react';
export function App() {
  const index = 0;
  const session = { profile: 'default', id: '123' };
  return (
    <StrictMode>
      <div className="min-h-screen" style={{ animationDelay: \`\${Math.min(index, 8) * 28}ms\` }} key={\`\${session.profile}:\${session.id}\`}>
        <p>1) Step one: click (here) or [there]</p>
        <span />
      </div>
    </StrictMode>
  );
}
`;
		fs.writeFileSync(tsxPath, validTsx, "utf8");
		const tsxValidRes = checkSyntax(tsxPath);
		assertPass("TSX with template literal attributes, self-closing tags, and text parens is valid", tsxValidRes.valid === true, { tsxValidRes });

		// Broken TSX (unclosed tag)
		fs.writeFileSync(tsxPath, "export const Broken = () => <div><span>hello</div>;", "utf8");
		const tsxBrokenRes = checkSyntax(tsxPath);
		assertPass("TSX with unclosed tag is detected as invalid", tsxBrokenRes.valid === false, { tsxBrokenRes });

		logPass("TypeScript & TSX syntax verification passed!");
	} finally {
		ws.cleanup();
	}
}
