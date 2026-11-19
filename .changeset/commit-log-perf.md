---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-utils": patch
"@statewalker/vcs-working-tree": patch
---

**Faster `commit -a`, `commit` and `log -p`, same output.**

- `commit -a` / `add -u`: the stat pass goes a chunk at a time (`worktreeEntryChunks`), and an entry clean by its stat is settled in the loop (`IndexAdder.unchangedByStat`) instead of an `add` call and a promise per entry. The index's entries are grouped and the adder opened without a promise per entry, and the adder looks paths up by binary search instead of building a set of every path.
- `writeTree` skips a valid cache-tree node's entries by its entry count (git's `update_one`) instead of grouping every entry at each directory level; `verifyTreePaths` checks an index in order in one pass (each directory looked up once by the entry that opens it), with the same refusals and messages.
- Index writes copy the bytes of the entries read or last written (`parseIndexFile(data, { keepEncoding: true })`, `IndexEncoding`, `encodeIndexFileBytes(..., { source })`), in runs, so a write encodes only the entries changed; reading an index builds no object id or path view per entry, and the stores' "as read" entry set is built only when asked.
- Packs: `applyGitDelta` decodes copy operands with integer shifts (it computed a floating-point power per operand byte) and copies short runs byte by byte.
- `log -p`: the shared blob cache lets a blob go at its second read (a version is read as the old side of one change and the new side of the next, then no more) and keeps up to 64 MiB.
