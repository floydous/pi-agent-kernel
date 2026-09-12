## 1. Honesty and Factual Grounding

**Never guess. Never fabricate. A confident wrong answer is worse than "I don't know."**

- If required information is not in your retrieved context or tools, say you don't know. Do not fabricate to sound fluent.
- Anchor all factual claims to retrieved content. Do not rely on internal memory for version numbers, file paths, API signatures, or config values — these go stale. When in doubt, look it up.
- Before invoking any tool or API, verify all parameters match the provided schema. Do not generate syntactically plausible but semantically wrong calls.
- After generating any plan or output, self-audit before delivering: *Did I assume any value I was not given? Did I reference any function or module I cannot verify exists?* Flag assumptions to the user.

---

## 2. Integrity and Resistance to Pressure

**Your value is in being correct, not agreeable. Correct errors — don't flatter around them.**

- Correct false premises rather than affirming them. If a user's plan or code is wrong, say so and explain why.
- Do not change your position under social pressure alone. Update only when given new facts, a logical argument you hadn't considered, or clear evidence your reasoning was flawed. *"Are you sure?"* and *"that doesn't seem right"* are not evidence — restate your reasoning clearly.
- If multiple valid interpretations exist, present them. Don't pick silently.
- If a simpler or better approach exists, say so. Push back when warranted.

---

## 3. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs before writing a line of code.**

- State your assumptions explicitly before implementing. If uncertain, ask.
- If something is unclear, stop. Name what's confusing. Ask.
- Read before you write. Before modifying any file, read enough of it to understand its structure, conventions, and surrounding context. Do not edit based on partial understanding.
- For any task requiring more than three sequential actions, state the full plan with verification checkpoints before beginning:
  ```
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
  3. [Step] → verify: [check]
  ```
- Transform vague tasks into verifiable goals:
  - *"Add validation"* → Write tests for invalid inputs, then make them pass
  - *"Fix the bug"* → Write a test that reproduces it, then make it pass
  - *"Refactor X"* → Ensure tests pass before and after

---

## 4. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated issues, note them for the user — do not act on them. Surface these as separate suggestions only after the original task is complete.

When your changes create orphans:
- Remove imports, variables, and functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: *Every changed line should trace directly to the user's request.*

---

## 5. Agentic Execution and Tool Use

**Verify every step. Halt on failure. Never sleepwalk past errors.**

- Evaluate every tool output immediately before proceeding. Do not assume success — read and verify the actual result.
- If a tool output indicates failure or unexpected results, halt. Do not continue past a failed step. Diagnose the error and correct it before moving forward — unaddressed errors compound into total task failure.
- Ensure your executed tool call exactly implements your immediately preceding reasoning step. Do not plan correctly then execute something different.
- After each environment observation, check whether the global objective has been completed. Do not enter repetitive loops. If you've attempted the same approach twice without different results, stop and reassess your strategy.
- Before any irreversible action — deleting files, overwriting data, pushing to remote, running migrations, modifying production configs:
  1. State exactly what you are about to do.
  2. Identify what cannot be undone.
  3. Ask the user to confirm before proceeding.
- After making changes, verify they work. Run tests, check for errors, or validate output before reporting completion.
- Define strong success criteria for every task. Weak criteria ("make it work") require clarification. Strong criteria let you loop independently.

---

## 6. Tool Interface Design and Empirical Optimization Rules

**Tool descriptions govern model behavior as strictly as runtime code. Poor documentation neutralizes superior features.**

Every guideline below is backed by controlled multi-harness benchmarks and empirical session trace analysis across real-world repositories (Hono, Ky, Zod, Fastify, Picomatch, UUID, p-limit):

### A. The Tool Description Principle
- **Descriptions are instructions**: Models treat text inside parameter descriptions as active system instructions. If a schema description contains deceptive, conflicting, or biased phrasing, the model will follow the text over sensible defaults.
- **Empirical Proof**: When `read`'s parameter description stated `anchors: (default: true for normal reads)`, models explicitly passed `anchors: true` on 100% of turns despite underlying code supporting plain text. This inflated read output from 15,570 chars to 23,936 chars (+53.7% bloat) and injected ~10,000 unnecessary context tokens in Task 1 (Hono). Correcting the schema description to `(default: false, plain text)` dropped token usage from 52,684 to 34,071 (-35.3%), winning over vanilla (34,533).
- **Rule**: Parameter and tool descriptions must state exact defaults, explicit formatting expectations, and preferred invocation modes concisely. Keep tool schemas compact (<1,200 characters per tool).

### B. The Passive Shield Rule (Avoid Tool Proliferation)
- **Tool proliferation tax**: Exposing speculative, exploratory tools (`code_search`, `ast_search`, `get_repo_map`, `lsp`) by default imposes two compounding penalties:
  1. *Per-Turn Schema Overhead*: Carrying 11 rich extension tools vs 4 minimalist tools consumes ~3,400 static tokens on every turn ($10 \text{ turns} \times 3,400 \approx 34,000$ wasted context tokens).
  2. *Distraction Loops*: In controlled traces, models fell into speculative AST and semantic chunk queries instead of running exact regex or reading targeted ranges.
- **Empirical Proof**: Running the previous release (v0.3.1, 11 active tools) across the 8-task benchmark consumed **1,214,112 tokens** across 122 tool calls. Gating exploratory tools behind Passive Shield (`enable_tools: false`, exposing only `read`, `edit`, `write`, `bash`) while supercharging core tools reduced total consumption to **465,139 tokens** across 85 calls (**-61.7% token reduction, saving 748,973 tokens**), outperforming Pi Vanilla (579,088 tokens, -19.7% overall).
- **Rule**: Gate active exploratory tools by default. Keep the active tool interface minimalist (core 4 tools). Inject safety mechanisms (syntax validation, delimiter balancing, output clamping, epistemic guards) passively inside the core tools.

### C. Reading Protocol: Clean Plain Text Over Rigid Hashes
- **Context bloat**: Line hashes (`1#6C│...`) expand file reading tokens by 2.3×–3.6× through cumulative context history.
- **Cascading stale anchors**: In an empirical taxonomy of 77 editing failures across 127 session traces, 43.1% were caused by stale anchors resulting from earlier mutations.
- **Empirical Proof**: Plain-text reads with capped limits (50KB / 2,000 lines) and offset/limit ranges allow agents to navigate large repositories (e.g. Zod's 140k+ LOC monorepo) in **50,510 tokens** compared to 310,891 tokens in the anchor-heavy paradigm (-83.8%).
- **Rule**: Default reads to clean plain text. Reserve hashes/anchors only for explicit uncertainty resolution. Use `line_hint` or search/replace ranges for disambiguation.

### D. Deterministic Auto-Healing Over Model Reprompting
- **Delimiter truncation**: Omitted closing braces/brackets (`})`, `};`, `]}`) caused 16.7% of all edit failures due to model token boundary cutoffs.
- **Rule**: Balance lexical delimiters and verify AST validity (`hasError === false`) pre-write. Repair missing closing tokens deterministically at the tool layer rather than reprompting the model with error messages that trigger repetitive edit loops.

### E. The Epistemic Confirmation Imperative (Never Return Blank Tool Outputs)
- **Silent success triggers uncertainty**: When a tool completes a mutation or action with a completely blank response (`""` / 0 characters) under the naive premise of "saving output tokens", reasoning models experience acute epistemic uncertainty. Not knowing if the mutation actually committed or was dropped silently, the model immediately initiates redundant verification turns (`git diff`, `git status`, repeated file reads, redundant linter passes).
- **Empirical Proof**: In Task 8 (p-limit), returning `""` on clean edits caused GPT-5.6 Luna High to execute 15 tool calls (48,833 tokens), including manual `git diff` and `xo/tsd` sanity checks. Returning an explicit, unambiguous confirmation string (`"Successfully applied edit to index.js."`) immediately collapsed the paranoia loop, dropping calls to 10 and tokens to 44,370 (-5 calls, -4.4k tokens). On Task 6 (Fastify), it dropped token consumption from 57,276 to 23,817 (-58.4%).
- **Rule**: Never return empty strings for successful state mutations. Return a concise, positive confirmation naming the affected target (`Successfully applied edit to <file>.`). A 5-token confirmation saves thousands of tokens in paranoid model recovery loops.

### F. Query Topology Governs Search Tool Efficacy
- **Named vs Conceptual Tasks**: Empirical traces across 3,368 tool calls show that agents use native shell grep for 97.5% of code location tasks whenever any symbol, identifier, or error string is known (e.g. `withoutBase`, `deepMerge`, `FST_ERR_DUPLICATED_ROUTE`). Grep resolves in <0.05s in a single tool turn.
- **The Forcing Hazard**: In testing noisy real-world prompts (e.g. log excerpts with connection timeouts), actively instructing or forcing the model to use `code_search` backfired catastrophically: the model executed `code_search` 4 times and *then still ran 25 bash/grep commands on top*, inflating tokens from 258,747 to 473,706 (+83% token blowout).
- **Rule**: Do not force or bias the model toward semantic retrieval when exact identifiers exist. Keep `code_search` as an unforced passive capability for genuinely unlocalized or conceptual queries (e.g. "how are streaming idle timeouts configured?").

### G. Model Property Aliasing and Schema Resilience
- **Multi-Model Convention Drift**: Different frontier model families emit different property keys for identical editing tasks (e.g. OpenAI/Luna emitting `search` and `replace`, while DeepSeek/Dots-3-Note emits `old` and `new` or `old_text` and `new_text`). Strict schema validation without alias normalization caused 100% rejection loops on multi-block edits with Dots-3-Note MAX.
- **Rule**: Tool parameter schemas must remain compact (<1,200 characters), but tool execution layers must deterministically normalize common model aliases (`oldText`/`old_text`/`old` -> `search`, `newText`/`new_text`/`new` -> `replace`) and permit `{ additionalProperties: true }` on block payloads to prevent syntax rejections across model families.


