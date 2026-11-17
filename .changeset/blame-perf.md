---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-commands": patch
---

**Faster `git blame`, with the same output.**

- **vcs-commands:** `BlameCommand` splits, hashes and numbers the lines of each version of the file once, through one `LineInterner` for the whole walk, instead of again in every diff; lines in the tail a diff trims (`trim_common_tail`) are not read at all, and a blob read as one chunk is not copied. The algorithm, its blame entries and tie-breaks are git's as before. On a 1000-commit history of a 3000-line file blame takes about 40% of the time it took (about 1.6× native git, from 3.7×). The interner's memory is bounded: past 64 MiB of distinct lines (`BlameCommand.setInternerByteLimit`) blame starts a new interner, and a version from the old one is interned again when compared with one from the new.
- **vcs-utils:** `LineInterner` numbers distinct lines (under xdiff's whitespace flags) across diffs (`byteSize` tells how many bytes of lines it holds), and `InternedText` reads a file's lines on demand; `XdiffOptions.interner` lets xdiff classify lines by those numbers (the same classes, numbered alike), and `xdiffHunks` takes either side as a `LineSource` (`ByteLines` or `InternedText`). `ByteLines.prefix` gives the lines of a prefix sharing the line table and hashes. xdiff's line classification uses a typed hash table, and `trimCommonTail` compares four bytes at a time. The pooled inflater resets a state without allocating new code tables (pako's reset allocated two per object), which makes reading small objects such as commits and trees about 20% faster.
