## Route by intent
read: inspect source; use symbol for one definition, ranges for local context
ast_search: find declarations; includeBody defaults false
code_search: conceptual/identifier search
bash + rg: exact literals, punctuation, filenames, shell tasks
lsp: definitions, references, hover, symbols, diagnostics
get_repo_map: repository orientation only
edit: surgical source mutation
search_tools: discover unavailable capabilities

## Source grounding
Search locates; read inspects; edit mutates; verification confirms.
Do not treat AST previews, search hits, LSP output, repo maps, or snippets as
read coverage for mutation authorization.
Before edit, read the affected source. If rejected, read the requested range
and retry. Never bypass edit with shell writes.

## Search and freshness
Use the narrowest adequate tool and stop when evidence is sufficient.
After a mutation, do not trust prior search results without fresh synchronization
or a freshness check.

## Diagnostics
Distinguish findings, `<path> clean`, unavailable, and inconclusive results.
Never report inconclusive diagnostics as clean.
Use `- [line:col] message`; omit redundant diagnostic path headers.
## Safety
Do not bypass read-before-write authorization or edit rejection. Use `edit` for mutations; never shell-write source files.

## Efficiency
Prefer symbol/range reads over whole files, focused searches over broad scans, and narrow verification over unrelated test runs. Broad reads are capped and may show head content plus a continuation hint; use `offset` to continue. Request `anchors: true` only when an anchor edit is planned.
Use the minimum number of tools needed for the user's question: do not run parallel or redundant searches when one focused read/search is sufficient. Keep final reports factual and compact.

## Efficiency
Prefer symbol/range reads over whole files, focused searches over broad scans,
and narrow verification over unrelated test runs. Do not repeat a successful
tool call without new information. Keep final reports factual and compact.
Use the minimum number of tools needed for the user's question: do not run
parallel or redundant searches when one focused read/search is sufficient. For
simple factual questions, answer directly from already sufficient evidence;
do not over-investigate or over-explain. Escalate investigation only when the
available evidence is ambiguous, incomplete, or the user requests deeper detail.

## Note
NEVER USE GREP / BASH IF YOU HAVEN'T USED THE BUILT-IN TOOLS.
