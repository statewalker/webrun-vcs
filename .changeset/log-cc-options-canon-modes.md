---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": patch
---

**`git log --cc` diffs with the diff options, and tree comparisons see canonical modes, as git does.**

- **vcs-commands:** `log -p --cc` / `-c` diffs each parent with the diff options (`-w`, `-b`, `--ignore-space-at-eol`, `--ignore-cr-at-eol`, `--ignore-blank-lines`, the algorithm, and the indent heuristic, on by default through `diff.indentHeuristic`), as combine-diff.c passes `xdl_opts`; before, it diffed with none of them, so hunks could sit a line off from git's. Tree diffs (`diff`, `log -p`/`--stat`/`--name-status`, history simplification by path, combined diffs) compare entry modes as git's walk reads them: a 100664 entry is 100644, so the same blob under both is no change. The small-blob cache a `log -p` shares counts a blob read by concurrent opens once.
- **vcs-core:** `canonTreeMode` (git's `canon_mode`); `TreeEntryCursor.mode` is canonical, and the commit-graph writer's changed-path walk compares canonical modes. `BlobRead.bytes` is documented read-only (a cache may hand the same buffer to every reader).
- **vcs-utils:** `hashLine` and `LineHasher` give the one line hash of `ByteLines` and `InternedText`: an `InternedText` diffed against plain bytes or `ByteLines` (with or without the interner) now gives the plain diff, where its lines hashed differently before. Buffers passed to `unifiedDiffHunks` must not change afterwards (their lines are remembered by buffer).
