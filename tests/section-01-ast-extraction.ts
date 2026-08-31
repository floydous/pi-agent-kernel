// Section 1: AST Extraction
// Tests the extractFileTags function on a Python class with multiple methods.

import { extractFileTags } from "../src/retrieval/repomap";
import { runSection, assertPass, logPass } from "./_setup";

async function main(): Promise<void> {
	await runSection("1. AST Extraction", () => {
		const pyCode = `
class Calculator:
    def __init__(self, precision: int = 2):
        self.precision = precision

    def calculate_tax(self, subtotal: float) -> float:
        """Calculate tax based on subtotal."""
        return subtotal * 0.08

    def process_discount(self, subtotal: float, discount: float) -> float:
        return subtotal - discount
`;
		const tags = extractFileTags("calc.py", pyCode);
		console.log(
			"Found definitions:",
			tags.definitions.map((d) => `${d.kind}: ${d.name} (${d.signature})`),
		);
		assertPass(
			"AST extraction test passed",
			tags.definitions.length >= 3 &&
				tags.definitions.some((d) => d.name === "Calculator"),
			{ definitions: tags.definitions },
		);
		logPass("AST extraction test passed!");
	});
}

main().catch((err) => {
	console.error(err);
	throw err;
});
