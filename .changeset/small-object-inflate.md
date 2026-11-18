---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": patch
---

**Faster one-shot inflate of small objects; fsck's grafts hint with a commit-graph and its links limit.**

- **vcs-utils:** `inflateWhole` builds a dynamic block's Huffman tables about a third faster (the header's reader buckets the symbols by code length as it decodes the lengths, so the builder does not sort them, and the root table is filled by doubling as libdeflate does instead of one write per entry), refills its bit buffer with four bytes at once without a branch and decodes two literals per refill, copies overlapping matches by doubling, and sums the Adler-32 word by word from 32 bytes on. Commits inflate about 25% faster, trees 15%, small blobs 35%; the result is byte for byte the same and fails where zlib fails (differential tests against node zlib on git objects of every type, levels 0 to 9, every strategy, and damaged ones).
- **vcs-core:** a `VerifyCommitSource` gets a second argument, `note`, which adds a line to the verification's messages where the commit is read.
- **vcs-commands:** `fsck` with a commit-graph, `core.commitGraph` on and `info/grafts` prints the grafts deprecation hint twice, as git does (once more from `git commit-graph verify`, when it parses its first commit). `setMemoryLimits({ links })` is a limit on the links kept in all (the pack-order scan's and the walk's tree records together), the arrays never grow past it, and 0 keeps none.
