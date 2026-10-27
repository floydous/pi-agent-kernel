import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkFile } from "../../src/retrieval/search_chunker";
import { TreeSitterEngine } from "../../src/retrieval/tree_sitter_engine";

// Longer than 40 lines, so the file is chunked by entity rather than as one block.
const RUST = `use std::time::Duration;

pub struct Backoff {
    base: u64,
}

impl Backoff {
    pub fn new(base: u64) -> Self {
        Self { base }
    }

    pub fn delay(&self, attempt: u32) -> Duration {
        Duration::from_millis(self.base * 2u64.pow(attempt))
    }
}

#[cfg(not(test))]
pub fn sleep_for(delay: Duration) {
    std::thread::sleep(delay);
}

pub fn test_label(attempt: u32) -> String {
    format!("attempt {attempt}")
}

#[test]
fn top_level_test() {
    assert_eq!(Backoff::new(1).delay(0), Duration::from_millis(1));
}

#[tokio::test]
async fn async_top_level_test() {
    assert!(Backoff::new(2).delay(1) > Duration::from_millis(0));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        backoff: Backoff,
    }

    impl Fixture {
        fn make() -> Self {
            Self { backoff: Backoff::new(10) }
        }
    }

    fn helper() -> Backoff {
        Backoff::new(5)
    }

    #[test]
    fn retry_delay_backoff_doubles_each_retry_delay_backoff_attempt() {
        // retry delay backoff: the retry delay backoff doubles per retry
        assert_eq!(helper().delay(1), Duration::from_millis(10));
    }
}
`;

export async function run(): Promise<void> {
	console.log("=== Running Rust Inline Test Tests ===");
	await TreeSitterEngine.getInstance().loadLanguages([".rs"]);
	const previousPiDir = process.env.PI_DIR;
	const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rust-tests-pidir-"));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rust-tests-ws-"));
	process.env.PI_DIR = piDir;
	try {
		fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
		const file = path.join(workspace, "src", "backoff.rs");
		fs.writeFileSync(file, RUST);

		console.log("1. Items under test attributes become test chunks; other items keep their kinds...");
		const kinds = Object.fromEntries(chunkFile(workspace, file, RUST).map((c: any) => [c.symbolName, c.kind]));
		for (const name of ["top_level_test", "async_top_level_test", "Fixture", "make", "helper", "retry_delay_backoff_doubles_each_retry_delay_backoff_attempt"]) {
			assert.equal(kinds[name], "test", `${name} should be a test chunk (got ${kinds[name]})`);
		}
		assert.equal(kinds.Backoff, "class");
		assert.equal(kinds.new, "method");
		assert.equal(kinds.delay, "method");
		assert.equal(kinds.sleep_for, "function", "#[cfg(not(test))] is not a test attribute");
		assert.equal(kinds.test_label, "function", "a name starting with test_ is not a test");

		console.log("2. Source/test separation moves inline tests behind source hits...");
		fs.writeFileSync(path.join(workspace, "src", "retry.rs"), "pub fn retry_delay(attempt: u32) -> u64 {\n    // backoff for a retry\n    2u64.pow(attempt)\n}\n");
		const { HybridSearchIndex } = require("../../src/retrieval/search_index");
		const index = new HybridSearchIndex(workspace, "lean", { projectTrusted: true });
		await index.syncWorkspace(true);
		const query = "retry delay backoff";
		const inlineTest = (hit: any) => hit.chunk.symbolName.startsWith("retry_delay_backoff_doubles");
		const plain = await index.search(query, { limit: 5 });
		assert.ok(inlineTest(plain[0]), "precondition: the inline test outranks source without separation");
		const separated = await index.search(query, { limit: 5, separateTests: true });
		const testAt = separated.findIndex(inlineTest);
		assert.ok(testAt > 0, "the inline test is still returned");
		assert.ok(separated.slice(0, testAt).every((hit: any) => hit.chunk.kind !== "test"), "every hit before it is source");
		await index.flushPendingSave?.(true);

		console.log("✓ Rust inline tests are marked as tests and separated from source!");
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_DIR;
		else process.env.PI_DIR = previousPiDir;
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(piDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	void run();
}
