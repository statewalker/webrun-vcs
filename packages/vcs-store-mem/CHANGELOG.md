# @statewalker/vcs-store-mem

## 0.6.0

### Minor Changes

- 8a603c0: **Status detects renames and reads submodules as git; `clean -X`; racy smudging on every staging store.**
  
  - **vcs-commands (behaviour change):** `git.status()` detects renames as git's default `status.renames=true`: a path removed from the index paired with one added to it is one entry `R  old -> new` (porcelain v2 `2 R. ... R<score> new<TAB>old`), a path deleted from the worktree paired with an intent-to-add file is ` R old -> new`; untracked files are never paired. Scores and pairing follow git's `diffcore_rename` (exact renames, unique basenames at 75%, then the best pairs at 50%, `diff.renameLimit`/`status.renameLimit`, default 1000). `status.renames` (else `diff.renames`) and new `setRenames(boolean)` (`--[no-]renames`) and `setRenameLimit(n)` control it. New `Status.renamed` (new path to old path), `StatusFileEntry.renamedFrom`/`renameScore`/`intentToAdd`, status code `R`. The paths stay in `added`/`removed`/`missing` too.
  - **vcs-commands (behaviour change):** a populated submodule's own index and worktree are read (as git's `is_submodule_modified`): tracked changes inside show ` M sub` with v2 `S.M.`, untracked files `S..U`, with a new commit `SCMU`; nested submodules count as git counts them. `diff.ignoreSubmodules`, `submodule.<name>.ignore` (config, then `.gitmodules`) and new `setIgnoreSubmodules("none" | "untracked" | "dirty" | "all")` (`--ignore-submodules`) behave as git; `setUntracked(false)` also stops looking for untracked files inside submodules. New `StatusFileEntry.submoduleModified`/`submoduleUntracked`, exported `submoduleToken()`.
  - **vcs-commands:** new `CleanCommand.setIgnoredOnly(true)` is `git clean -X`: only ignored files go (with `-d`, ignored directories and directories holding only ignored content, as git; path filters as git's).
  - **vcs-commands:** stash apply's rename detection uses the same git-exact detection (`detectRenames`, git's similarity estimate).
  - **vcs-store-files:** an absolute submodule gitdir (`gitdir: /abs/.git/modules/sub`, older git, `--separate-git-dir`) inside the FilesApi's root directory is read (status sees its commit and content; `clean -d` removes a directory whose absolute gitfile names a place without HEAD); outside the root it stays unreadable (shown clean, kept by clean). New `FileWorktree.openGitlink(path)` opens a populated submodule as a working copy through the same FilesApi.
  - **vcs-working-tree:** new optional `Worktree.openGitlink(path)`.
  - **vcs-utils:** new optional `PosixFilesApi.rootDirectory` (the real directory a local FilesApi is rooted at), which `PosixNodeFilesApi` already exposes.
  - **vcs-store-mem, vcs-store-kv, vcs-store-sql:** the staging stores implement `setRacyCheck`: every write (editor, builder, `write()`) smudges racily clean entries that changed (size 0) against the time of the store's previous write, as `GitStaging`/`FileStagingStore` do. The KV and SQL stores keep that time with their entries (`staging:__meta__`; new SQL migration 8, `staging_meta`) and `read()` restores it.

### Patch Changes

- eadd78c: **`commit --only` takes the listed paths literally under the index lock, and no staging writes a tree with two entries of one name.**
  
  - **vcs-commands:** `commit --only` lists paths as git's `list_paths` (pathspec magic and globs such as `d/`, `*.md`, `:(glob)d/**`, `:!d/x`, `./a`, matched against the index and HEAD, each element reported when it matches nothing) and takes each one as `add_remove_files` does: a file staged, a path gone removed, and a path that is now a directory refused before anything changes (`'a' does not have a commit checked out`), where it used to leave both `a` and `a/inner` staged and commit a corrupt tree. A glob character in a path no longer stages untracked files it happens to match.
  - **vcs-commands:** `commit --only` and `commit -a` hold `index.lock` from before they edit the index until HEAD has moved, as git does: the new index goes into the lock and is renamed over the index after the ref update; a concurrent writer is refused meanwhile, and a failed commit leaves the index (and the instance's unwritten edits) as they were.
  - **vcs-commands:** `add` replaces the entries a new one clashes with as a file or a directory (git's `check_file_directory_conflict`: adding `a/b` removes `a`, adding `a` removes `a/...`), and a path given an entry or removed has its cache-tree path invalidated as git's index edits do, so `TREE` matches git's byte for byte while conflicts remain.
  - **vcs-working-tree:** `Staging.lockIndex()` (optional; `GitStaging` and `FileStagingStore` implement it) holds the index lock for a write committed or rolled back later, on top of `IndexFile.lock()`. `verifyTreePaths` refuses a file that is also a directory ("You have both a and a/b"), checked by every staging's `writeTree`. `RemoveStagingStages` is the edit `IndexEditor.remove(path, stage)` records. A cache-tree set with `setCacheTree` is what `getCacheTree` returns until the write.
  - **vcs-store-files, vcs-store-mem, vcs-store-kv, vcs-store-sql:** `removeEntry(path, stage)` and `editor.remove(path, stage)` remove only that stage, and `editor.remove(path)` every stage of a conflicted path.
  - **Tests:** the staging suite (vcs-testing) checks stage-specific removal and the file/directory refusal of `writeTree`, and runs for `FileStagingStore` and `GitStaging` too.
- eadd78c: **Index flags and the cache-tree survive index rewrites as in git, and more sequencer leftovers match git.**
  
  - `reset --hard`, `reset --mixed`, `checkout -f`, `reset --merge`/`--keep` and the autostash reset of `merge --autostash` and rebase keep skip-worktree and assume-unchanged flags as unpack-trees does. An entry the target leaves unchanged keeps its flags. A changed entry keeps its skip-worktree bit. A skip-worktree file the tree keeps is not written. Before this, `git ls-files -v` showed every flag dropped. `Staging.readTree` takes `keepMatching` (`true` keeps the old entry, `"flags"` keeps only its flags) for this one-way merge.
  - An entry whose flags cheat is checked against its file by its stat, as git's `verify_uptodate_1` does. `reset --hard` and `checkout -f` refuse such an entry when they would change or delete it over a changed file ("Entry 'f' not uptodate. Cannot merge."). A branch switch refuses an assume-unchanged file whose stat changed, even when its content did not.
  - `stash apply --index` applies the stash's index as git does: a `diff-tree --binary` of it, run through `apply --cached`. A hunk whose context the index no longer has now fails with "error: patch failed: ...", "patch does not apply" and "conflicts in index. Try without --index.", where we used to merge it.
  - `am --skip` cleans the index as git's `clean_index` does (the same as `am --abort`): a refusal ends with "failed to clean index", and a merge state left behind is removed.
  - The cache-tree (`TREE`) now survives index edits as in git. When entries change, the paths that changed go invalid and every other directory stays valid. Before this, the whole extension was dropped. So a commit after an edit keeps an untouched subtree stored as 100664, and the commit ids match native git. `commit` writes the index with a fully valid cache-tree (git's `prepare_index`), and `checkout`, `reset --merge` and `reset --keep` update it before they write (`cache_tree_update` with `WRITE_TREE_REPAIR`). The `TREE` bytes match native git's.
  - `verifyCacheTree` (vcs-working-tree) checks that every valid cache-tree node describes the index entries below it, for tests and fsck.
- eadd78c: **`add -N` no longer turns a tracked file into a deletion, and `commit --only` commits what git commits.**
  
  - **vcs-commands:** `add -N` leaves a path with a stage-0 entry (tracked or already intent-to-add) as it is, as git's `ADD_CACHE_NEW_ONLY`; before, a tracked file became an empty intent-to-add entry and the next commit deleted it. A conflicted path still has its stages replaced, as git does.
  - **vcs-commands:** `commit --only <paths>` is git's partial commit: the paths the given ones name in the index or HEAD are taken from the worktree (cleaned; a file gone removed, an intent-to-add file with its content) into the index and into HEAD's tree, which is committed; the index keeps its other staged changes and is written once the commit is made. A path nothing knows fails with git's `pathspec ... did not match`, a partial commit during a merge, cherry-pick or rebase is refused, other unmerged paths do not stop it, and an amend starts from HEAD.
  - **vcs-commands:** every index-writing command (add, rm, commit, reset, checkout, switch, merge, cherry-pick, revert, rebase, am, pull, stash push/apply, apply `--index`/`--cached`, and clean for reading) reads the index again at its start when another writer replaced it, as git does, and refuses with `IndexChangedError` before touching anything only when the instance holds unwritten edits. `commit` now re-reads instead of refusing.
  - **vcs-working-tree, vcs-store-files, vcs-store-mem, vcs-store-kv, vcs-store-sql:** the stagings' builders and editors copy the whole stat data of an entry (nanoseconds, uid, gid), so an index rewritten around a few paths (`rm` of many entries, `commit --only`) no longer leaves the others stat-dirty. `Staging.hasUnwrittenChanges()` (optional) tells whether an instance holds edits made since it read or wrote the index.
- eadd78c: **A staged deletion survives `stash apply --index`, and `rm` keeps the flags of the other entries.**
  
  - `stash apply --index` could write a cache-tree that no longer described the index: a path removed from the index outside the merged paths stayed in a valid directory node, and the next commit (ours or native git's) put the deleted file back. The index it leaves now has git's fully valid cache-tree (`reset_tree`'s `cache_tree_update`).
  - A cache-tree set with `setCacheTree` no longer goes stale when entries change before the write. The staging records the entries it describes, and the write invalidates every path that changed since, as it already did for the cache-tree read from the index.
  - Intent-to-add entries are left out of every tree, as git's `update_one` leaves them out, even when they are also skip-worktree. Before this, `git add -N new; git update-index --skip-worktree new` committed `new` as an empty file.
  - `rm` keeps the other entries as they are. Before this, it rebuilt them from path, mode and id: intent-to-add entries became real entries naming a blob never written, and skip-worktree, assume-unchanged and the stat data were dropped. `commit --only` also gives the index its own entries back once it has written its tree.
  - `commit` refuses an index that another writer replaced since this instance read it (`IndexChangedError`), as index writes do, instead of committing the stale entries.
  - `rebase` goes on over a dirty assume-unchanged or skip-worktree file, as git's `require_clean_work_tree` does. The stat check of flagged entries counts an intent-to-add entry as changed and finds no racy entry in an index without a timestamp, as git's `ie_match_stat` does.
- c80355f: **Merge, rebase, cherry-pick and revert do work proportional to what they change, not to the repository.** Output is unchanged; in a repository of 5000 files on the files backend a merge of five changes a side goes from about 1.1 s to about 0.3 s, a 200-commit rebase from 58 s to 10 s, and a rebase onto 1000 upstream commits from 7.6 s to 1.9 s.
  
  - **vcs-commands:** a merge over stored trees reads them as git's merge-ort does: a directory all three trees hold with the same id is one entry, never read (`prunedFlatTrees`), and a directory taken whole from one side is that side's tree. Only when directory renames are found (or the base is a virtual merge of several bases) are the whole trees merged, as before. The result is stored by rewriting only the changed directories, HEAD and the result are compared by tree ids (`treeDelta`), so only the paths that change are checked against the index and worktree and written, and "the index matches HEAD" compares tree ids computed from the index (as git's cache-tree) instead of reading HEAD's whole tree. A worktree file whose stat matches its index entry, on an entry older than the index (not racy), is no longer hashed (git's `ie_match_stat`); the clean-worktree check of a rebase stats files several at a time. The index is read and rewritten without an await per entry.
  - **vcs-core:** trees are cached by id once read or stored (and concurrent reads of one tree read it once), commits once parsed. The caches never serve an object the store no longer holds: the stores report each object removal (`noteObjectRemoved`, a process-wide `objectRemovalEpoch`), and a cache hit read before the last removal is checked with `objects.has` first, so a tree or commit that gc, prune, a repack or a discarded quarantine removed in the same process reads as absent on every backend; decoding and encoding trees no longer re-encode names per comparison or convert ids through regular expressions. Pack reads go through a shared cache of 64 KiB windows (long entries still stream from the file). A write of an object held in memory is hashed first and skipped when the object is already stored (git's `freshen_object`); `StagingBlobStore.isFresh` (optional) tells the object kernel.
  - **vcs-commands, the index as git leaves it:** merge, cherry-pick, revert and rebase write the cache-tree (`TREE` extension) unpack-trees writes, from the index's own cache-tree with only the changed directories computed again (conflicted paths and the directories of intent-to-add entries invalid); a refused merge leaves the index restore_state leaves. An entry the merge updates keeps its skip-worktree bit. `cherry-pick -n` and `revert -n` rewrite the index as git's `write_index_as_tree` does when its cache-tree is not fully valid, so an entry as new as the rewritten index is racy and a same-size local edit behind a matching stat is refused, as git refuses it; the stat-match skip trusts a matching stat only on an entry older than the index (an exact stat match on a racy entry is read too). A refused merge drops the change of an assume-unchanged file, as restore_state's `reset --hard` does.
  - **vcs-working-tree:** the index is written in version 3 exactly when an entry has an extended flag (skip-worktree, intent-to-add) and in version 2 otherwise, and only such entries carry the extended flags word (git's `do_write_index`); the cache-tree is read and written (`CacheTree`, `cacheTreeOfTree`, `updateCacheTree`, `Staging.getCacheTree` / `setCacheTree`, optional). The tree of an index leaves out its intent-to-add entries, as git's write-tree (also in the memory, KV and SQL stagings). An index rewrite encodes only the entries that changed (the bytes of an unchanged entry are reused) and compares entries instead of hashing them to decide whether the cache-tree survives; the checksum is converted to hex once. `Staging.entryList()` (optional) gives every entry at once.
  - **vcs-store-files:** a loose object is read without checking first that its file exists, a ref without an extra existence check (a files API whose read throws for a missing file still reads it as absent), and the index builder's stage check is linear.
  - **vcs-utils:** `bytesToHex` uses a lookup table.
- 1efa875: **Paths that are not UTF-8 in pattern files, patches, command text and the SQL store, as in git.**
  
  - **vcs-utils:** `decodeGitPatternFile` reads a pattern file as git does (bytes through `decodeGitPath`, a leading BOM skipped); `unquoteGitPath` is git's `unquote_c_style` on bytes. The patch parser reads C-quoted names (`"a/caf\351.txt"`, in `diff --git`, `---`/`+++`, `rename`/`copy` lines and `diff --cc`) and raw names (`core.quotePath=false`) as the paths trees and the index hold, and splits two unquoted names with spaces where both halves name the same path, as `git apply` does.
  - **vcs-working-tree, vcs-store-files:** `.gitignore`, `info/exclude`, `core.excludesFile` and `.gitattributes` keep their bytes: a latin-1 rule (`caf\xe9.txt`, `*\xe9*`) matches the path bytes git matches, so status, clean, add and the `text`/`eol`/`ident` conversions agree with git.
  - **vcs-commands:** `DiffCommand.callText()` and `DiffFormatter.toString()` decode the output bytes with `decodeGitPath`: a byte that is not UTF-8 is an escape instead of U+FFFD, and `encodeGitPath(text)` is `callBytes()`. `formatStatusPorcelain` takes `{ quotePath }` (`core.quotePath=false` prints the bytes) and quotes control characters with git's letters (`\r`, `\a`, ...). `diff.orderFile` patterns keep their bytes. State files (`MERGE_MSG`, ...) are written and read as bytes, so a conflicted latin-1 path is listed as git lists it, and conflict lists and the stash and sequencer path orders follow git's byte order (`compareGitPaths`).
  - **vcs-store-sql:** paths and tree entry names in TEXT columns (`tree_entry`, `tree_delta_entry`, `staging_entry`) store a lone surrogate as U+0001 and four hex digits (`toSqlPath` / `fromSqlPath`), since drivers turn it into U+FFFD. UTF-8 names are stored unchanged, so no migration is needed. A tree rebuilt from the store keeps its id.
  - **vcs-store-sql, vcs-store-kv, vcs-store-mem:** staging entries sort in git's byte order (`compareGitPaths`) instead of UTF-16 code units.
- Updated dependencies [a8277da]
- Updated dependencies [a8277da]
- Updated dependencies [a8277da]
- Updated dependencies [d333a4d]
- Updated dependencies [09aa062]
- Updated dependencies [a86d47a]
- Updated dependencies [8681320]
- Updated dependencies [d5158af]
- Updated dependencies [d84c354]
- Updated dependencies [d84c354]
- Updated dependencies [f1cab9d]
- Updated dependencies [8a603c0]
- Updated dependencies [8a603c0]
- Updated dependencies [05a5cae]
- Updated dependencies [9517fc9]
- Updated dependencies [0135cdd]
- Updated dependencies [1777896]
- Updated dependencies [1777896]
- Updated dependencies [e306a5e]
- Updated dependencies [d489ee7]
- Updated dependencies [20c317e]
- Updated dependencies [eadd78c]
- Updated dependencies [21d6866]
- Updated dependencies [e1c44ca]
- Updated dependencies [457680a]
- Updated dependencies [7f697fd]
- Updated dependencies [257e9cf]
- Updated dependencies [de6af72]
- Updated dependencies [a8df903]
- Updated dependencies [0a39cdc]
- Updated dependencies [57846c3]
- Updated dependencies [f078ebd]
- Updated dependencies [5863bf1]
- Updated dependencies [35239a9]
- Updated dependencies [65474c5]
- Updated dependencies [32f7288]
- Updated dependencies [53ecad0]
- Updated dependencies [bbf5ca1]
- Updated dependencies [df0147c]
- Updated dependencies [8a603c0]
- Updated dependencies [eadd78c]
- Updated dependencies [eadd78c]
- Updated dependencies [eadd78c]
- Updated dependencies [5a488ed]
- Updated dependencies [54f881d]
- Updated dependencies [9cf798e]
- Updated dependencies [7314646]
- Updated dependencies [8329312]
- Updated dependencies [2ce29f8]
- Updated dependencies [2ce29f8]
- Updated dependencies [2d0759a]
- Updated dependencies [c80355f]
- Updated dependencies [422447b]
- Updated dependencies [7314646]
- Updated dependencies [79b57ea]
- Updated dependencies [c3ee332]
- Updated dependencies [9e462a8]
- Updated dependencies [1efa875]
- Updated dependencies [98be9b5]
- Updated dependencies [87d6d55]
- Updated dependencies [af93342]
- Updated dependencies [d489ee7]
- Updated dependencies [d489ee7]
- Updated dependencies [2796b2d]
- Updated dependencies [7c63add]
- Updated dependencies [966768c]
- Updated dependencies [68ef504]
- Updated dependencies [bd2140b]
- Updated dependencies [7dc8308]
- Updated dependencies [979230c]
- Updated dependencies [979230c]
- Updated dependencies [9234799]
- Updated dependencies [32ab2c4]
- Updated dependencies [68c571d]
- Updated dependencies [f745816]
- Updated dependencies [2523eff]
- Updated dependencies [b7426bc]
- Updated dependencies [d676bf4]
- Updated dependencies [65e2515]
- Updated dependencies [68cedb7]
- Updated dependencies [e8828f6]
- Updated dependencies [f62ca9b]
- Updated dependencies [479fa64]
- Updated dependencies [f0d8ddd]
- Updated dependencies [8a603c0]
- Updated dependencies [0b1ccae]
- Updated dependencies [0b1ccae]
- Updated dependencies [eb5ad83]
- Updated dependencies [8a603c0]
- Updated dependencies [7a834b2]
- Updated dependencies [21b0bd6]
- Updated dependencies [b31fadc]
- Updated dependencies [5558be8]
- Updated dependencies [c80355f]
- Updated dependencies [7dc8308]
- Updated dependencies [190f0e1]
- Updated dependencies [35239a9]
- Updated dependencies [819e88c]
- Updated dependencies [0798366]
  - @statewalker/vcs-working-tree@0.6.0
  - @statewalker/vcs-core@0.6.0
  - @statewalker/vcs-utils@0.6.0

## 0.5.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core crosses a breaking line
  - @statewalker/vcs-utils crosses a breaking line
  - @statewalker/vcs-working-tree crosses a breaking line

### Patch Changes

- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [875db86]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [01d2219]
- Updated dependencies [3818fee]
- Updated dependencies [3292f46]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [d45dfb0]
  - @statewalker/vcs-working-tree@0.5.0
  - @statewalker/vcs-utils@0.5.0
  - @statewalker/vcs-core@0.5.0

## 0.4.0

### Minor Changes

- 6964023: **New (vcs-core):** `Refs.batch(commands, options?)` applies ref updates atomically: all of them or none. It follows `git update-ref --stdin`'s rules:
  - names must be `HEAD` or valid names under `refs/`;
  - no duplicates;
  - no directory/file conflicts;
  - each `old` must match (`undefined` means no check, `null` means the ref must not exist);
  - commands follow symbolic refs unless `noDeref` is set. With `noDeref`, `old` is still compared with the resolved value, as git does.
  
  It returns `{ ok, rejected: [{ name, reason }] }`.
  
  Two rules are project policy rather than git's:
  - a detached HEAD cannot join a multi-ref batch (`not-atomic`);
  - symbolic-ref chains are followed for at most 5 refs.
  
  A symbolic ref pointing outside `refs/` is refused as `invalid-name`.
  
  **Also new:**
  - `planRefBatch`, the backend-independent planner, with its view and result types `RefBatchView`, `PlannedRefUpdate` and `RefBatchPlan`. A planned update carries the raw value it read and the refs whose reflogs also record it (HEAD included, as git logs it).
  - `isUpdatableRefName`, plus the types `RefCommand`, `RefRejectReason`, `RefRejection`, `BatchResult` and `BatchOptions`.
  
  **Breaking:**
  - `batch` is required on every `Refs` implementation.
  - `MemoryRefStore` is removed. It duplicated `MemoryRefs`; use `MemoryRefs` (vcs-store-mem re-exports it).
  - `MemoryRefs.compareAndSwap` is now a one-command batch:
    - it refuses names outside `HEAD` / `refs/` (e.g. `ORIG_HEAD`), D/F conflicts, and symbolic-ref chains longer than 5;
    - on a symbolic `HEAD` it updates the target instead of detaching HEAD;
    - on failure, `errorMessage` names the reason.
  - `MemoryRefs.set`, `setSymbolic` and `remove` apply in order with batches, under one write lock: await them before reading.
  - `MemoryRefs.list` snapshots the refs when iteration starts.
  
  **Interim (deprecated, will be removed):** `batchBySingleRef` / `SingleRefWriter`. The SQL, KV and git-files stores run one command through `compareAndSwap`, so a batch is only as atomic as that is. They refuse multi-command batches, and `noDeref` on a symbolic ref, as `unsupported` until their atomic batches land.
  
  **Fixed (vcs-store-files):**
  - `compareAndSwap` now works on refs that exist only in packed-refs, and writes through a symbolic ref to its target.
  - `delete` removes a ref from packed-refs too.
  
  **New (vcs-testing):** `createRefBatchTests(name, factory, { multiRef?, symbolicRefs? })`, the batch contract suite.
- 5684650: **Breaking: every store uses git's SHA-1 object ids; the FNV-1a ids are gone.**
  
  Removed: `computeCommitHash`, `computeTreeHash` and `computeTagHash` (vcs-core), `MemoryCommitStore` / `MemoryTreeStore` / `MemoryTagStore` (vcs-store-mem), `KVCommitStore` / `KVTreeStore` / `KVTagStore` with their scan queries (vcs-store-kv), and `SQLCommitStore` / `SQLTreeStore` / `SQLTagStore` (vcs-store-sql). Use `createMemoryObjectStores()`, `createKvObjectStores({ kv })`, and `createSqlNativeStores(db)` or `createSqlObjectStores({ db })`.
  
  `SQLHistoryFactory` (`createHistory("sql", …)`) now wires the native SQL stores, so its trees, commits and tags get git ids. Persisted ids change: databases it wrote before hold FNV ids in `tree`, `tree_entry`, `vcs_commit`, `commit_parent`, `vcs_tag`, `vcs_ref`, `vcs_reflog`, `tree_delta` and `tree_delta_entry`, and KV stores in `commit:`, `tree:` and `tag:` keys. There is no migration; re-import from a git remote.
  
  The shared tree, commit and tag suites check ids against ones git computes.
- 60dd7da: **Breaking: every store reads and writes objects through the object kernel (`GitObjects`).**
  
  Removed: `GitObjectStore`, `GitObjectStoreOptions`, `createGitObjectStore`, `GitObjectHeader`, `loadWithHeader`, `VolatileStore`, `VolatileContent`, `MemoryVolatileStore` (vcs-core); `FileVolatileStore` / `createFileVolatileStore` (vcs-store-files); `createGitObjectStoreTests` and `createVolatileStoreTests` (vcs-testing). Replace `createGitObjectStore(raw)` with `createGitObjects(rawStorageStaging(raw))`, and for a `.git/objects` directory use `createGitObjects(filesStagingStore(files, objectsDir))`.
  
  - `createBlobs`, `createTrees`, `createCommits`, `createTags` and `createHistoryFromComponents({ objects })` take a `GitObjects`; `createMemoryObjectStores`, `createKvObjectStores` and `createSqlObjectStores` return one as `objects`.
  - `Blobs.store(content, size?)`: with a size, the blob is written in one pass without being buffered.
  - `createGitFilesBackend` builds its objects as `withPacks(createGitObjects(skipPacked(filesStagingStore(...), packs)), packs)`: reads try loose objects, then packs, and an object already packed is not written again (as git and JGit). gc and repack ignore anything in `objects/` that is not an object file, such as git's `objects/ab/tmp_obj_*` in flight.
  - The typed stores' `remove` still returns false for a string that is not an object id; `GitObjects.remove` throws `InvalidObjectIdError` for one.
  - Stored bytes: the memory, KV and SQL object stores (and the `BlobStore` behind `createVcsCore` and `createStorageRepositoryFacade`) now hold zlib loose objects, as `.git/objects` does. Data those stores persisted before is not readable; re-import from a git remote.

### Patch Changes

- 0a580e3: **Breaking: no store holds a whole large object in memory.** A git id hashes `"blob <size>\0"` first, so every write now either knows the size and streams once, or spools to temporary storage.
  
  - **vcs-core:** `GitObjects.putUnsized(type, content)` (new, required for `GitObjects` implementations) keeps content up to `spoolThreshold` (`createGitObjects(store, { spoolThreshold })`, 1 MiB by default) in memory and spools longer content through the optional `StagingBlobStore.spool(content)` (`SpooledContent`) before `put`; `blobs.store` without a size and the tree, commit and tag stores use it. `RawStorage.move?(from, to)` is new and optional; `rawStorageStaging` streams into a `tmp_obj_*` key and renames it when the raw store has `move` (`MemoryRawStorage` does), and spools to such a key. `VcsCore.writeBlob(bytes, { size })` and `SerializationApi.importObject(type, content, size?)` take sizes; `TypedStoreAccess.importObject` now receives the size. Content up to `STAGING_INLINE_THRESHOLD` (256 KiB, `rawStorageStaging(raw, { inlineThreshold })`) skips the temporary: `has` + `store`, nothing written for a duplicate; an id already stored keeps its value. `CompressedRawStorage.size()` streams and counts; with the new `{ gitObjects: true }` option it reads only a git object's header. `RawStorage.sweepStale?`, `StagingBlobStore.sweepStale?`, `GitObjects.sweepStale?` and `GcStrategy.sweepStale?` remove leftovers of interrupted writes; `GcOrchestrator.run({ staleExpiryMs })` (default `DEFAULT_STALE_EXPIRY_MS`, two weeks) calls them and reports `removedTemporaries`. New: `fixedSizeChunks`, `RAW_STAGING_TMP_PREFIX`, `DEFAULT_SPOOL_THRESHOLD`, `sweepStaleRawStaging`.
  - **vcs-store-kv / vcs-store-sql:** `KvRawStore` and `SqlRawStore` cut values over 256 KiB (`{ chunkSize }`) into chunks written as they stream in and read one at a time, and implement `move`. Values written in the old single-entry / single-row format keep reading. SQL migration 6 (`raw_store_chunks`) upgrades existing `raw_objects` / `raw_store` tables; `SqlRawStore` upgrades any table on first use (`upgradeRawStoreTable`). `Migration.upgrade` runs programmatic steps. `SqlNativeBlobStoreImpl.store` streams: with a size it hashes while writing chunks, without one it writes chunks first and reads them back to hash. `importToNative` / `exportToGit` pass blob sizes. `KvRawStore.sweepStale`, `SqlRawStore.sweepStale` and `SqlNativeBlobStoreImpl.sweepStale` remove orphaned chunks and `tmp:*` placeholder rows (chunk tokens record their creation time); `SqlGcStrategy.sweepStale` calls the native one. Raw-store overwrites are last writer wins; a reader concurrent with an overwrite may fail with `Missing chunk`. Rolling back migration 6 deletes rows of chunked values (data loss; `Migration.downgrade`).
  - **vcs-store-files:** `filesStagingStore` spools to `tmp_obj_*` files. The stash stores worktree files with their sizes.
  - **vcs-working-tree:** `storeWorktreeFile` moved here from vcs-commands (still re-exported there); after a `SizeMismatchError` it re-stats the file and retries once with the new size. It now returns `{ id, entry }`, the stat that matched the stored content, which the add commands record in the index.
  - **vcs-testing:** `createRawStorageTests` covers chunked values, failed writes, `move` (`supportsMove`) and streaming writes (`persistedBytes`); `createGitObjectsTests` covers `putUnsized` and, with `persistedBytes`, a 50 MiB blob written and read back with the producer never more than a few MiB ahead of the store.
  - **vcs-utils:** `randomHexId`, `timestampedId` and `timestampOfId` build ids from `crypto.getRandomValues`; no package source uses `crypto.randomUUID` any more (missing on non-secure browser origins).
- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [44b3105]
- Updated dependencies [e509d97]
- Updated dependencies [658066d]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [07ace72]
- Updated dependencies [f440ae3]
- Updated dependencies [b6a5d9c]
- Updated dependencies [08309ab]
- Updated dependencies [accab85]
- Updated dependencies [ee92812]
- Updated dependencies [c2c944f]
- Updated dependencies [8c6e99c]
- Updated dependencies [060fcd0]
- Updated dependencies [6a3a31d]
- Updated dependencies [33612d4]
- Updated dependencies [6964023]
- Updated dependencies [6343211]
- Updated dependencies [5684650]
- Updated dependencies [bb70139]
- Updated dependencies [0a580e3]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [60dd7da]
- Updated dependencies [c767140]
- Updated dependencies [46f2a01]
- Updated dependencies [b758bc0]
  - @statewalker/vcs-utils@0.4.0
  - @statewalker/vcs-core@0.4.0
  - @statewalker/vcs-working-tree@0.4.0

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core ^0.3.1 -> ^0.3.2
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.3
  - @statewalker/vcs-utils@0.3.2
  - @statewalker/vcs-working-tree@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-core@0.1.1
  - @statewalker/vcs-utils@0.1.1
  - @statewalker/vcs-working-tree@0.1.1
