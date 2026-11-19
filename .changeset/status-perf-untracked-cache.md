---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

**`git status` is faster and keeps git's untracked cache (`UNTR`).**

- The stat pass compares each index entry with its file synchronously where the stat settles it (`isCleanByStat`, `compareWithWorktreeStat`), so only racy, changed or submodule entries cost a promise; stat entries are plain objects with their name and ignore flag as prototype getters, and the Node FilesApi converts an lstat with fewer BigInt operations.
- Untracked files are found by `scanUntracked` (git's `read_directory` for `-uall`): index lookups by binary search (`IndexPathLookup`), no nested-repository check for directories the index has, no sort per directory.
- The untracked cache is read, used, updated and written as git does (dir.c: ident, dir flags, `info/exclude` and `core.excludesFile` ids and stats, per-directory stat data and `.gitignore` ids, valid/check-only bitmaps), byte for byte, for `status.showUntrackedFiles=all`; `core.untrackedCache` (true / false / keep, `feature.manyFiles`), `GIT_DISABLE_UNTRACKED_CACHE` and `GIT_FORCE_UNTRACKED_CACHE` are honoured. Index writes keep the extension and invalidate the directories of the paths they add or remove, as `untracked_cache_invalidate_path` does (it used to be dropped).
- New: `Worktree.untrackedScanHost`, `Staging.getUntrackedCache` / `setUntrackedCache`, `refreshStats(updates, { untrackedCache })`, `LinkStats.statSize`, `listKinds(path, { readdirOrder })`, and `GitHostEnvironment.systemName` / `statFile` (set by `createNodeGitHostEnvironment`).
