# 03. No workspace-wide grep with AST context — real escape hatch, low impact

## Factual re-test

The problem exists: `ast_search` finds declarations, while references require
LSP symbol context (or a shell search). On the polyglot fixture, searching the
literal `withConnection` produced two locations: the declaration at
`src/app.ts:27` and the call at `src/app.ts:96`. The bounded context output was
132 characters, essentially the same size as the current LSP-style formatter
(134 characters).

The current workflow can therefore be:

```text
ast_search(name="withConnection")       # declarations
lsp(..., symbol="withConnection", action="references")
# or bash rg -n -C 2 "withConnection" .
```

A first-class grep tool would make the shell escape explicit and could attach an
enclosing symbol, but the search result itself is not materially smaller than
what `rg` already provides.

## Session evidence

The original Gateway audit counted 20 of 67 bash calls using `rg`/`grep` and
10,845 characters of output. A fresh audit of the extension research session
counted 43 of 249 bash calls containing `rg`/`grep`, but many were investigation
commands rather than normal coding workflow. The evidence confirms regular
usage, not a large token bottleneck.

## Verdict

**Issue confirmed as a workflow gap, not a major efficiency problem.** Do not
add a custom grep abstraction yet: `bash` already exposes the native tool and
LSP references cover the semantic case. Add a small native search tool when
shell use is unavailable or when enclosing-AST context is demonstrably needed.

This is consistent with Headroom's methodology: route and compress tool output
according to content, rather than replacing a capable existing primitive merely
because it is not wrapped in a new API.
