# 12. `bash` output truncation is silent

## What I struggled with

When `bash` output exceeds the truncation limit, the tail gets saved to a
temp file, but the response I see doesn't surface *where* the truncation
happened or *which* temp file holds the rest. The harness docs mention
"Output is truncated to last 2000 lines or 50KB" but in practice the
truncation point inside the body is unmarked — I can't tell from looking
at the result that I'm seeing only the tail and not the whole output.

For long outputs (e.g., `cargo test` results, large file dumps, `git log`),
this matters because:

- Decisions made on the visible tail may miss context in the truncated
  head.
- The temp file path is mentioned in passing in the docs but not echoed in
  the response itself, so I'd have to remember the convention to follow
  up.
- If the output is truncated mid-line, the parser may fail or I may
  mis-attribute data.

## Measured cost in this session

The largest `bash` output in this session was 5,400 chars — well under
the 50KB truncation limit. So `bash` output truncation **did not actually
happen** in this session. The finding is about a *potential* issue that
would arise in longer-running sessions (e.g., `cargo test`, `git log` on
a large repo) where the limit matters.

The 23 "truncated" mentions in the session were all from `code_search`
chunk previews being cut at the body size cap, not from `bash` output
truncation. That's a different issue (covered in #9).

1. **Mark truncation in the response body.** A clear header or footer line
   like `[output truncated: showing lines 1800-2000 of 3842; full output
   at /tmp/pi_bash_spillover_xxx.log]` would let me act on it.
2. **Default to head+tail when truncating.** Showing the first 20 lines and
   the last 20 lines (with a clear marker in between) preserves more useful
   context than just the tail. Tail-only is the worst possible default for
   log-style output, where errors tend to be early.

## Smallest change that would help today

Append a truncation marker to the visible body that names the spillover
file and gives the line range that's missing. One line of metadata, removes
all the silent-truncation ambiguity.