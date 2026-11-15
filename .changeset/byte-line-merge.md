---
"@statewalker/vcs-utils": minor
---

**`mergeLines`: a byte-preserving three-way line merge.** `mergeLines(base, ours, theirs, { oursLabel?, theirsLabel?, algorithm? })` merges as git's `xdl_merge` does for a text file:

- Lines are split on LF and keep their terminators. Nothing is decoded, so CRLF files, a missing final newline and non-UTF-8 text come out byte for byte.
- Changes that touch or overlap conflict, unless both sides made the same change.
- Conflicts are written with git's markers (`<<<<<<< <ours>` / `=======` / `>>>>>>> <theirs>`) in the file's line ending.

It returns `{ content, conflicts }`. Also new: `ByteLines` (the line sequence) and `BYTE_LINES_COMPARATOR`. `merge3Way` is unchanged.
