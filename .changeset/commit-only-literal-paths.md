---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-store-mem": patch
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-commands": patch
---

**`commit --only` takes the listed paths literally under the index lock, and no staging writes a tree with two entries of one name.**

- **vcs-commands:** `commit --only` lists paths as git's `list_paths` (pathspec magic and globs such as `d/`, `*.md`, `:(glob)d/**`, `:!d/x`, `./a`, matched against the index and HEAD, each element reported when it matches nothing) and takes each one as `add_remove_files` does: a file staged, a path gone removed, and a path that is now a directory refused before anything changes (`'a' does not have a commit checked out`), where it used to leave both `a` and `a/inner` staged and commit a corrupt tree. A glob character in a path no longer stages untracked files it happens to match.
- **vcs-commands:** `commit --only` and `commit -a` hold `index.lock` from before they edit the index until HEAD has moved, as git does: the new index goes into the lock and is renamed over the index after the ref update; a concurrent writer is refused meanwhile, and a failed commit leaves the index (and the instance's unwritten edits) as they were.
- **vcs-commands:** `add` replaces the entries a new one clashes with as a file or a directory (git's `check_file_directory_conflict`: adding `a/b` removes `a`, adding `a` removes `a/...`), and a path given an entry or removed has its cache-tree path invalidated as git's index edits do, so `TREE` matches git's byte for byte while conflicts remain.
- **vcs-working-tree:** `Staging.lockIndex()` (optional; `GitStaging` and `FileStagingStore` implement it) holds the index lock for a write committed or rolled back later, on top of `IndexFile.lock()`. `verifyTreePaths` refuses a file that is also a directory ("You have both a and a/b"), checked by every staging's `writeTree`. `RemoveStagingStages` is the edit `IndexEditor.remove(path, stage)` records. A cache-tree set with `setCacheTree` is what `getCacheTree` returns until the write.
- **vcs-store-files, vcs-store-mem, vcs-store-kv, vcs-store-sql:** `removeEntry(path, stage)` and `editor.remove(path, stage)` remove only that stage, and `editor.remove(path)` every stage of a conflicted path.
- **Tests:** the staging suite (vcs-testing) checks stage-specific removal and the file/directory refusal of `writeTree`, and runs for `FileStagingStore` and `GitStaging` too.
