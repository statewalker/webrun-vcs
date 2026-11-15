---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-store-files": patch
---

**Breaking: big-file guards in diff, merge and blame; streamed index writes; smaller utilities that never read without limit.**

- **vcs-core:** new `probeBlob(blobs, id, { bigFileThreshold })` returns `{ size, binary, big }`: the size from `Blobs.size`, and binary as git decides it (over the threshold, or a NUL byte in the first 8000 bytes), reading at most that prefix. `DEFAULT_BIG_FILE_THRESHOLD` (50 MiB, git's `core.bigFileThreshold`) moves from the pack writer to `history/blobs` and is still exported from the package root.
- **vcs-commands:**
  - `DiffFormatter` takes a `bigFileThreshold` option. A side over it, or binary, makes the entry binary, and then neither side is loaded; `oldContent` and `newContent` are set for text files only. The binary line now reads as git's: `Binary files a/<path> and b/<path> differ`, with `/dev/null` for an added or deleted side.
  - `MergeCommand.setBigFileThreshold(n)`. A big or binary file is never content-merged: `ContentMergeStrategy.OURS` and `THEIRS` take that side's file whole (as `git merge -X ours`), `UNION` reports a conflict.
  - `BlameCommand.setBigFileThreshold(n)`. Blaming a file over it rejects; a parent version over it is not compared (its lines stay with the child commit) and is never a rename candidate.
- **vcs-utils:**
  - `readHeader` and `readAhead` take a required `maxLength` (a positive integer; anything else throws `RangeError`), so a stream with no header end is never read without limit.
  - New `readPrefix(stream, maxBytes)` reads at most `maxBytes` and closes the source.
  - `RawText.isBinary` looks at the first 8000 bytes only (`RawText.BINARY_PROBE_LENGTH`), as git does.
  - `createPakoCompression()`'s `deflate` and `inflate` are push-based: each chunk goes through pako's `Deflate` / `Inflate` and the output is yielded as it comes. Before, they collected the whole input and produced one output buffer.
  - **Removed:** `IntermediateCache` (unused).
- **vcs-working-tree:** new `encodeIndexFile(entries, version)` yields the index in chunks of about 64 KiB, the trailing SHA-1 computed as it goes, and validates paths before the first chunk. `GitStaging.write()` streams it into `FilesApi.write`. `serializeIndexFile` returns the same bytes joined.
- **vcs-store-files:** the files staging store writes `.git/index` through `encodeIndexFile`.
- **vcs-transport:** `pktLineReader` keeps received chunks in a queue and parses from the front, so many small packets, or a large packet in small chunks, decode in linear time (it re-copied its buffer on every packet). `parsePacket` returns `remaining` as a view of its input instead of a copy.
