---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-utils": patch
---

**Merge, rebase, cherry-pick and revert do work proportional to what they change, not to the repository.** Output is unchanged; in a repository of 5000 files on the files backend a merge of five changes a side goes from about 1.1 s to about 0.3 s, a 200-commit rebase from 58 s to 10 s, and a rebase onto 1000 upstream commits from 7.6 s to 1.9 s.

- **vcs-commands:** a merge over stored trees reads them as git's merge-ort does: a directory all three trees hold with the same id is one entry, never read (`prunedFlatTrees`), and a directory taken whole from one side is that side's tree. Only when directory renames are found (or the base is a virtual merge of several bases) are the whole trees merged, as before. The result is stored by rewriting only the changed directories, HEAD and the result are compared by tree ids (`treeDelta`), so only the paths that change are checked against the index and worktree and written, and "the index matches HEAD" compares tree ids computed from the index (as git's cache-tree) instead of reading HEAD's whole tree. A worktree file whose stat matches its index entry, on an entry older than the index (not racy), is no longer hashed (git's `ie_match_stat`); the clean-worktree check of a rebase stats files several at a time. The index is read and rewritten without an await per entry.
- **vcs-core:** trees are cached by id once read or stored (and concurrent reads of one tree read it once), commits once parsed; decoding and encoding trees no longer re-encode names per comparison or convert ids through regular expressions. Pack reads go through a shared cache of 64 KiB windows (long entries still stream from the file). A write of an object held in memory is hashed first and skipped when the object is already stored (git's `freshen_object`); `StagingBlobStore.isFresh` (optional) tells the object kernel.
- **vcs-working-tree:** an index rewrite encodes only the entries that changed (the bytes of an unchanged entry are reused) and compares entries instead of hashing them to decide whether the cache-tree survives; the checksum is converted to hex once. `Staging.entryList()` (optional) gives every entry at once.
- **vcs-store-files:** a loose object is read without checking first that its file exists, a ref without an extra existence check, and the index builder's stage check is linear.
- **vcs-utils:** `bytesToHex` uses a lookup table.
