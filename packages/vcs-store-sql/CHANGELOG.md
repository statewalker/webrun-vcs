# @statewalker/vcs-store-sql

## 0.6.0

### Minor Changes

- 1efa875: **Paths that are not UTF-8 in pattern files, patches, command text and the SQL store, as in git.**
  
  - **vcs-utils:** `decodeGitPatternFile` reads a pattern file as git does (bytes through `decodeGitPath`, a leading BOM skipped); `unquoteGitPath` is git's `unquote_c_style` on bytes. The patch parser reads C-quoted names (`"a/caf\351.txt"`, in `diff --git`, `---`/`+++`, `rename`/`copy` lines and `diff --cc`) and raw names (`core.quotePath=false`) as the paths trees and the index hold, and splits two unquoted names with spaces where both halves name the same path, as `git apply` does.
  - **vcs-working-tree, vcs-store-files:** `.gitignore`, `info/exclude`, `core.excludesFile` and `.gitattributes` keep their bytes: a latin-1 rule (`caf\xe9.txt`, `*\xe9*`) matches the path bytes git matches, so status, clean, add and the `text`/`eol`/`ident` conversions agree with git.
  - **vcs-commands:** `DiffCommand.callText()` and `DiffFormatter.toString()` decode the output bytes with `decodeGitPath`: a byte that is not UTF-8 is an escape instead of U+FFFD, and `encodeGitPath(text)` is `callBytes()`. `formatStatusPorcelain` takes `{ quotePath }` (`core.quotePath=false` prints the bytes) and quotes control characters with git's letters (`\r`, `\a`, ...). `diff.orderFile` patterns keep their bytes. State files (`MERGE_MSG`, ...) are written and read as bytes, so a conflicted latin-1 path is listed as git lists it, and conflict lists and the stash and sequencer path orders follow git's byte order (`compareGitPaths`).
  - **vcs-store-sql:** paths and tree entry names in TEXT columns (`tree_entry`, `tree_delta_entry`, `staging_entry`) store a lone surrogate as U+0001 and four hex digits (`toSqlPath` / `fromSqlPath`), since drivers turn it into U+FFFD. UTF-8 names are stored unchanged, so no migration is needed. A tree rebuilt from the store keeps its id.
  - **vcs-store-sql, vcs-store-kv, vcs-store-mem:** staging entries sort in git's byte order (`compareGitPaths`) instead of UTF-16 code units.
- 68c571d: **Reflog lines as native git writes them, and `git worktree` from a bare repository.**
  
  - **vcs-commands:** every ref update of the porcelain writes git's reflog line, with the old and new ids, git's committer identity and git's message: `checkout: moving from main to feat` (HEAD only; a detached HEAD named by its full id), `commit: <subject>` / `commit (initial)` / `commit (amend)` / `commit (merge)` / `commit (cherry-pick)` (branch and HEAD), `reset: moving to <rev>`, `merge <names>: Fast-forward` / `Merge made by the 'ort' strategy.`, `rebase (start): checkout <onto>`, `rebase (pick)` / `(continue)`, `rebase (finish): <branch> onto <id>` and `returning to <branch>`, `rebase (abort): returning to <branch>`, `cherry-pick: <subject>`, `revert: <subject>`, `pull[ --rebase]: Fast-forward` (a `pull --rebase` that only fast-forwards merges `--ff-only --autostash`, as git; `--rebase` / `--autostash` are in the message only when given with `setRebase` / `setAutoStash`, not from the configuration), `clone: from <url>` (HEAD, the branch, `refs/remotes/<remote>/HEAD`; the remote's refs unlogged), `fetch[ --atomic][ <remote> <refspecs>]: fast-forward` / `forced-update` / `storing head` / `storing tag` / `storing ref` / `updating tag` (also under `fetch --atomic`, each ref its own message), `fetch` for `refs/remotes/<remote>/HEAD` set by `fetch.followRemoteHEAD`, `branch: Created from <start>` / `Reset to <start>`, `Branch: renamed a to b` (the log carried over), `update by push`, the `reset: moving to HEAD` of `stash push` and of `merge --abort`, `remote: renamed <old> to <new>` (a ref's log, the remote HEAD's included, carried over as git 2.5x does; a ref without a log gets none), and `tag: tagging <abbrev> (<subject>, <date>)` / `(tree object)` / `(blob object)` / `(other tag object)` (logged only with core.logAllRefUpdates=always). One command reads the clock once, so its lines share a time (a rebase's finish logs the branch and HEAD at one time, as git's single default date). The identity is git's `git_committer_info`: `GIT_COMMITTER_NAME/EMAIL/DATE` from the host environment, else `user.name` / `user.email` and the clock (a commit's committer for the commands that commit). The messages live in one place (`reflogMessages`, `committerIdent`, `parseGitDate`); `GitCommand.setReflogAction` is git's `GIT_REFLOG_ACTION`. `stash push` writes its index and untracked commits' messages with git's line end (the same stash ids as git). **`git pull` (changed):** without `setRebase`, `branch.<name>.rebase` and then `pull.rebase` decide whether a pull rebases, as in git (`isRebase()` reports only the option). A rebasing pull refuses a dirty tree before fetching with git's `cannot pull with rebase: You have unstaged changes.` (or `Your index contains uncommitted changes.`) unless it autostashes: `PullCommand.setAutoStash` is `--autostash` / `--no-autostash`, default `pull.autoStash`, then `rebase.autoStash`; the refusal is a result with `rebaseUsed: true`, `successful: false` and `rebaseResult.status` `UNCOMMITTED_CHANGES`, and `PullResult.fetchResult` is now optional (undefined then). A rebasing pull that fast-forwards still reports `rebaseUsed: true`, with `rebaseResult.status` `FAST_FORWARD` (and the merge's `mergeResult`). `RebaseCommand.checkCleanWorkTree(action)` is git's `require_clean_work_tree`. `FetchCommand.setAtomic` is `git fetch --atomic`. `Git.fromWorktreeAdmin` runs `worktree add/list/prune/lock/unlock/remove/move/repair` from a bare repository (`list` shows it `(bare)`); commands that need a working tree refuse there with git's `this operation must be run in a work tree`.
  - **vcs-core:** `Refs.set` and `Refs.setSymbolic` take an optional reflog line (`RefLogOptions`: `message`, `ident`); `setSymbolic` with a message logs as git's `create_symref` (old resolved id to the target's id, nothing for an unborn target); with `SymbolicRefLogOptions.reflog` it writes the lines given instead (a renamed symbolic ref's log). `RefCommand.message` gives one update of a batch its own reflog message. `symrefReflogWrites`. `BatchOptions.skipReflog` writes no reflog line (git's initial transaction). `symrefReflogLine`, `logsByDefault`, `defaultReflogIdent`. `MemoryRefs` logs both.
  - **vcs-store-kv, vcs-store-sql:** `set` and `setSymbolic` write the reflog lines they are given (`set` as a one-ref batch, `setSymbolic` as create_symref), so the porcelain logs on these backends too.
  - **vcs-store-files:** the files store and a linked worktree's refs honour those reflog lines; `worktree add` logs the new worktree's HEAD by the calling repository's `core.logAllRefUpdates` default, as git 2.5x writes it from the caller (from a bare repository nothing is logged); `GitLinkedWorktrees.openAdmin` gives a bare repository's history and configuration without a working copy.
  - **vcs-working-tree:** `WorktreeAdmin` and `LinkedWorktrees.openAdmin`; `GitHostEnvironment.committer` carries git's committer variables.
  - **vcs-transport:** fetch writes git's per-ref reflog messages (`reflogAction`, `reflogIdent`, `skipReflog`; `fetchReflogWhat`).
  - **vcs-utils-node:** `createNodeGitHostEnvironment` reads `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` and `GIT_COMMITTER_DATE`.
- b7426bc: **Revisions: abbreviated ids, `describe` names, ranges and revision sets, as git reads them.**
  
  - **vcs-core:** object stores look ids up by prefix. `GitObjects.listPrefix` (and `listObjectsWithPrefix`, which falls back to `list()`), `StagingBlobStore.listPrefix`, `RawStorage.keysWithPrefix` (`rawKeysWithPrefix`; the memory, compressed and composite stores implement it), `Pack.idsWithPrefix` (a binary search in the idx, as git's `find_short_packed_object`) and `PackSet.listPrefix`; quarantine views include their objects. `findAbbrevLengths` asks the store for the ids sharing the start length instead of listing every object when it can. `MINIMUM_ABBREV_LENGTH` is git's 4.
  - **vcs-store-files / vcs-store-kv / vcs-store-sql:** prefix lookups read one loose fan-out directory plus the packs' idx (files backend, `FileRawStorage`), a KV prefix scan, and an SQL key range.
  - **vcs-commands:** the revision resolver reads abbreviated ids (`get_short_oid`: 4 to 40 hex digits; the type the context needs or `core.disambiguate` picks among several objects; git's `error: short object ID ... is ambiguous` with its sorted `hint:` candidate list; `warning: refname 'x' is ambiguous.` for a ref that is also a short id), `git describe` names (`<ref>-<n>-g<abbrev>`, with git 2.5x's check of the ref and count parts (2.43 takes any `-g<abbrev>`)), and `./` / `../` paths in `<rev>:<path>` and `:<path>` relative to `RevParseCommand.setPrefix`. Commands that need a commit read abbreviations as committishes. New `git.revList()` (`RevListCommand`) lists the commits of `a..b`, `a...b`, `^a`, `x^@`, `x^!`, `x^-<n>` and `--not` (`parseRevisionArgs`, a port of `handle_revision_arg`); `revParse().addArgument()` prints arguments as `git rev-parse` does, `^<id>` lines included, and `--verify` prints a range before refusing it as git does. `RevisionError.output` holds what git printed on stdout before dying. `abbreviateId` abbreviates as git prints ids; merge's `Updating a..b` and `Created autostash:` and rebase's autostash, skipped-commit and todo-backup lines use it.
  - **vcs-commands (review fixes):** `revList()` reads its arguments as `git log` does (`--not` alone falls back to HEAD, a lone `..` is `HEAD..HEAD` as before `--`) and documents that its order is `LogCommand`'s walk, not yet git's date order. `lookup_commit_reference`'s `error: object <id> is a <type>, not a commit` is printed where git prints it: `<rev>~<n>` / `<rev>^<n>` of a tree or blob, a symmetric difference with such a side (`rev-parse` prints both sides first, as git; `log` dies with `Invalid symmetric difference expression`) and `rev-parse`'s parent shorthands; `rev-parse` without `--verify` reads an unknown argument again quietly before dying, as git's `maybe_die_on_misspelt_object_name` does. A `core.disambiguate` git does not know dies as git: `error: unknown hint type for 'core.disambiguate': <value>` (or `missing value`) and `fatal: bad config variable 'core.disambiguate' in file '<file>' at line <n>`. Commands count the objects once for the automatic abbreviation length however many ids they print (`createIdAbbreviator`, `GitCommand.abbreviateObjectId`).
  - **vcs-store-files:** `GitWorkingCopyConfig.getAllWithOrigin(key)` gives every value with the file and line it was read from and its text as written.
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

- d84c354: **A staged change carried over by a merge, checkout or pick is no longer lost by the next commit.**
  
  A fast-forward `merge` or `merge --squash` (and every operation that switches the index with git's two-way unpack-trees: picks, rebases, `am`) wrote the index's cache-tree from the target tree. A staged change on a path the two trees agree on stays in the index, so the cache-tree claimed directories the index does not hold, and the next commit (or native `git write-tree`) took the target's tree there: the staged change was dropped, or the commit refused as empty.
  
  - **vcs-working-tree:** `invalidateCacheTreeAgainstIndex` invalidates in a cache-tree computed from a tree every path where the index differs from that tree (an entry kept, added or removed), reading only the directories the index's previous cache-tree does not vouch for. The stagings' `writeTree` reuses a valid cache-tree node only when it counts the entries under it and its tree is stored (git's `update_one`), else it computes it again.
  - **vcs-commands:** the two-way switch derives the cache-tree it writes from the index it leaves.
  - **vcs-core:** a tree entry with an empty mode or another character than an octal digit fails to read with git's "malformed mode in tree entry" (`decodeTreeBytes`, `TreeEntryCursor`), instead of reading as a gitlink.
  - **vcs-store-sql:** the native tree store gives a tree's stored bytes (`raw`, modes as written), and `exportToGit` copies a tree through them, so a tree holding a 100664 blob keeps its id; a tree that would be written under another id fails loudly.
- d84c354: **Tree entry modes read as git reads them (`canon_mode`), everywhere.**
  
  A tree that stores a blob as 100664 (older git wrote it) now reads as 100644, as git's `decode_tree_entry` reads it, so a repository with such trees behaves as with native git: `status` is clean after `reset --hard`, and `merge`, `checkout`, `cherry-pick`, `revert`, `rebase` (patch-ids), `stash`, `reset`, `diff` and `log` no longer see a mode change between 100664 and 100644, or refuse with "local changes would be overwritten".
  
  - **vcs-core:** the tree store's `load`, `entries` and `getEntry` give canonical modes (`canonTreeMode`: a regular file 100644 or 100755 by its owner's execute bit, a symlink 120000, a directory 40000, anything else a gitlink); `raw` still gives the stored bytes, and serializing a stored tree (`SerializationApi`) copies them. `decodeTreeBytes(bytes, { canonicalModes: true })` reads canonical modes (without the option, modes as stored), and `treeModesRewritten(entries)` says whether such a list came from a tree written with other modes (encoding it again makes another tree). fsck keeps reading the modes as stored (`badFilemode` for 100664 under `--strict`).
  - **vcs-working-tree:** the files and git stagings' `writeTree` reuses the directories the index's cache-tree has valid, as git's write-tree does (a tree primed by a reset keeps its stored 100664 modes). `updateCacheTree` computes a directory as the canonical tree its entries make: where the stored tree holds other modes, that tree is valid only if stored (git's `WRITE_TREE_REPAIR`), else invalid.
  - **vcs-commands:** `reset --hard` primes the cache-tree with the target tree (`prime_cache_tree`) and `reset --mixed` keeps it with the changed paths invalid; `stash apply` invalidates the paths it merges. A combined diff's `-U0` hunk header prints a count below zero as git's `%lu` does (`+1,18446744073709551615`), in `diff` and `log --cc`.
  - **vcs-store-sql**, **vcs-transport-adapters:** syncing a tree to the SQL store and an object's size read the stored bytes; the native SQL tree store reads canonical modes.
- eadd78c: **`commit --only` takes the listed paths literally under the index lock, and no staging writes a tree with two entries of one name.**
  
  - **vcs-commands:** `commit --only` lists paths as git's `list_paths` (pathspec magic and globs such as `d/`, `*.md`, `:(glob)d/**`, `:!d/x`, `./a`, matched against the index and HEAD, each element reported when it matches nothing) and takes each one as `add_remove_files` does: a file staged, a path gone removed, and a path that is now a directory refused before anything changes (`'a' does not have a commit checked out`), where it used to leave both `a` and `a/inner` staged and commit a corrupt tree. A glob character in a path no longer stages untracked files it happens to match.
  - **vcs-commands:** `commit --only` and `commit -a` hold `index.lock` from before they edit the index until HEAD has moved, as git does: the new index goes into the lock and is renamed over the index after the ref update; a concurrent writer is refused meanwhile, and a failed commit leaves the index (and the instance's unwritten edits) as they were.
  - **vcs-commands:** `add` replaces the entries a new one clashes with as a file or a directory (git's `check_file_directory_conflict`: adding `a/b` removes `a`, adding `a` removes `a/...`), and a path given an entry or removed has its cache-tree path invalidated as git's index edits do, so `TREE` matches git's byte for byte while conflicts remain.
  - **vcs-working-tree:** `Staging.lockIndex()` (optional; `GitStaging` and `FileStagingStore` implement it) holds the index lock for a write committed or rolled back later, on top of `IndexFile.lock()`. `verifyTreePaths` refuses a file that is also a directory ("You have both a and a/b"), checked by every staging's `writeTree`. `RemoveStagingStages` is the edit `IndexEditor.remove(path, stage)` records. A cache-tree set with `setCacheTree` is what `getCacheTree` returns until the write.
  - **vcs-store-files, vcs-store-mem, vcs-store-kv, vcs-store-sql:** `removeEntry(path, stage)` and `editor.remove(path, stage)` remove only that stage, and `editor.remove(path)` every stage of a conflicted path.
  - **Tests:** the staging suite (vcs-testing) checks stage-specific removal and the file/directory refusal of `writeTree`, and runs for `FileStagingStore` and `GitStaging` too.
- 35239a9: **Small deviations from git fixed: empty config booleans, worktree pointer files, `addWorktree`'s admin directory.**
  
  - **vcs-utils:** `parseGitBool`, git's `git_config_bool`: a key with no `=` is true, an empty value (`key =`) is false, the spellings in any case, and integers as `git_parse_int` reads them (`0x10`, `010`, `1k`); anything else is undefined (git refuses it).
  - **Booleans everywhere read through it.** `core.ignorecase`, `core.filemode`, `core.symlinks`, `core.autocrlf`, `core.safecrlf`, `core.quotePath`, `filter.<driver>.required`, `merge.*`, `diff.*`, `blame.*`, `status.renames`, `status.showUntrackedFiles`, `extensions.worktreeConfig`, `core.bare` and the other boolean settings: an empty value used to read as true in several of them and now reads as false, as in git.
  - **vcs-store-files:** a `.git` file's `gitdir:` and `$GIT_DIR/commondir` are stripped of their trailing `\n`/`\r` only (`read_gitfile_gently`, `get_common_dir_noenv`), never trimmed; a `C:/…` commondir is absolute. New `parseGitfile`, `parseCommonDir`, `parseWorktreeGitdir`, `isAbsoluteGitPath`. `addWorktree` writes `worktrees/NAME/commondir` (`../..`), absolute host paths in the `.git` file and the `gitdir` back-pointer when the FilesApi's root is known, numbers the name when it is taken (`wt1`), and takes `lock` (`git worktree add --lock [--reason]`), so native git can use the worktree. `objects/info/alternates`, `FETCH_HEAD` and the merge/rebase state files are read and written as bytes (non-UTF-8 survives).
  - **vcs-working-tree:** `AddWorktreeOptions.lock`. With `core.ignoreCase` a directory's `.gitignore` applies to its path in any ASCII case (git's `fspathncmp`).
  - **vcs-commands:** `init` keeps non-UTF-8 bytes in the config when it sets `core.bare`/`core.ignorecase`.
  - **vcs-store-sql:** `findByNamePattern` returns entries in git's tree order (a subtree compares as `name/`).
  - **vcs-transport:** HTTP Basic auth sends the credentials' UTF-8 bytes (a lone surrogate as its byte); `btoa` threw on characters above U+00FF.
- 32f7288: **Path matching, case folding and git directory pointers as git does them, bytes included.**
  
  - **vcs-working-tree:** ignore and attribute patterns compare their literal prefix and `*suffix` as bytes when the pattern holds bytes that are no UTF-8, so `caf\xc3*` or `*\xa9` takes the UTF-8 `café` as in git (`wildmatchBytes` and `sameBytes` are exported next to `wildmatch`). Ignore rules now honour `core.ignoreCase` (`IgnoreRule.matchesPath(path, isDirectory, ignoreCase)`, `IgnoreNode.checkIgnored(..., ignoreCase)`, `IgnoreManager.setIgnoreCase`, `createIgnoreManager({ ignoreCase })`, `Worktree.setIgnoreCaseReader`, set by working copies from their configuration). Attributes with `core.ignoreCase` fold ASCII letters only, as git's `fspathncmp` does, so `É` no longer matches `é`.
  - **vcs-utils:** `foldAsciiCase` lowers ASCII letters only (git's `tolower` / `strncasecmp`).
  - **vcs-commands:** `:(icase)` pathspecs in `clean`, the case-insensitive name lookups of the overwrite checks and of merge-ort's unique paths fold ASCII only, as git's `strncasecmp` and `memihash`.
  - **vcs-core:** `.git` / `.gitmodules` spellings (HFS+, NTFS) fold ASCII only, as git's `verify_path`; no accepted or refused path changes.
  - **vcs-store-files:** a `.git` file's `gitdir:`, a `.git` link's target, `commondir`, a submodule's HEAD and refs, and the config file are read as bytes (`decodeGitPath`), and `addWorktree` writes the `gitdir:` file and the back-pointer as bytes: a git directory whose path is no UTF-8 is found, and rewriting the config keeps a latin-1 value's bytes.
  - **vcs-store-sql:** `SQLStaging.listEntriesUnder` is a range query: no longer ASCII case-insensitive and no `_` / `%` wildcards (`src` no longer lists `SRC/…`, `a_b` no longer lists `aXb/…`). `searchMessage` takes `%`, `_` and `\` literally. `findByNamePattern` returns entries by tree id and then by name in git's byte order.
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
- d489ee7: **Local remotes, rebase by name, missing stashes, attr pathspecs and exit codes.**
  
  - `rebase().setUpstream()` takes a revision (`main`, `HEAD~2`, a tag) as well as an id. It is resolved when the rebase starts and fails with git's `fatal: invalid upstream '<x>'` before anything is written. Before, the name itself was written into `.git/HEAD`. The reflog keeps the name as given (`checkout main`).
  - Every ref store refuses a direct ref value that is not a full lowercase hex object id. This covers `set`, `compareAndSwap` and `batch` in the files, memory, KV and SQL stores (`isRefObjectId`, reject reason `invalid-object-id`), so a name can no longer end up in a ref. Symbolic refs are written as before.
  - `fetch`, `ls-remote`, `clone` and `push` reach a repository named by a path or a `file://` URL, as git's local transport does. The repository is opened through the working copy's storage (`Worktree.openRepository`, which follows git's `enter_repo`), and upload-pack or receive-pack is served in process over an in-memory duplex. A path with no repository there fails with git's "does not appear to be a git repository" lines; a clone of such a path fails with "repository '<path>' does not exist". A `<helper>::` address or an unknown scheme fails with git's "unable to find remote helper for '<scheme>'".
  - `stashDrop` and `stashApply` fail as git does on a missing stash: "No stash entries found.", "error: stash@{n} is not a valid reference" (exit status 128, as in git 2.5x) and "fatal: log for 'stash' only has N entries". `setAll(true)` without a stash still returns undefined.
  - `stash push -u` with `:(attr:...)` enters an untracked directory only when the directory's own name and attributes match as a leading path, as dir.c's `treat_directory` does (`PathspecAttributes.reachable`, shared with `add`).
  - Exit codes are inferred from a message's prefixes only where git puts them: `usage:` or `error:` on the first line, and `fatal:` on the last line (or the first). A path in a listing, such as `fatal: x.log`, no longer changes the status. Error classes that always end with the same status set it explicitly (`AddFailedError`, `EmptyCommitError`, `NoMessageError`, `NotMergedError` and others).
  - `commit().callDryRun()` honours `setInclude`: it runs the same option checks, stages the named tracked paths on the held index, shows the status, and rolls the index back.
  - An initial commit, or `--amend` of a root commit, with an empty index (or one holding only intent-to-add entries) fails with "nothing to commit" unless `setAllowEmpty`.
  - When the status is not part of the template, an editor's commit decides whether there is anything to commit with git's `index_differs_from` (HEAD, or HEAD^1 when amending) instead of a status run. As a result, `--amend` with `setIncludeStatus(false)` no longer refuses a commit that changes the amended commit's parent.
  - `add().setCompatibility("2.43")` refuses `:(attr:...)` with git 2.43's message, so `stash push` under 2.43 compatibility fails after saving the stash, as git 2.43 does. `diff` of trees in a bare repository works and reads the bare attributes for `:(attr:...)`, as `log` does. `PathspecAttributes.forWorktree` without a worktree throws a `GitApiError` instead of a plain `Error`.
- c80355f: **Tree entries are sorted exactly as git sorts them, so some tree ids change to git's.** A directory `a` next to a file `a-` (or any file whose name continues `a` with a byte below `/`, such as `a!` or `a.`) used to compare equal to it: the order of the two in the encoded tree then followed the order the entries came in, and a tree built from a different order got an id native git never writes (and `git fsck` reports as not properly sorted). Now a tree compares as its name plus `/` in every case (git's `base_name_compare`), so `a-`, `a.b`, then the tree `a`, then `a0`, whatever the input order. Trees that were written in git's order before keep their ids; a tree written out of order before is written with a new id (git's) when it is built again.
  
  - **vcs-core:** `compareTreeEntries` and `compareTreeEntryNames` (exported) are git's tree order over UTF-8 bytes; `encodeTreeEntries`, `serializeTree` and the structural tree deltas use them (the deltas sorted with `localeCompare` before).
  - **vcs-store-sql:** the native tree store sorts and hashes trees with the same comparator (it compared UTF-16 strings).
  - **vcs-commands:** patch ids walk trees in that order.
- Updated dependencies [a8277da]
- Updated dependencies [a8277da]
- Updated dependencies [a8277da]
- Updated dependencies [d333a4d]
- Updated dependencies [09aa062]
- Updated dependencies [8681320]
- Updated dependencies [d5158af]
- Updated dependencies [d84c354]
- Updated dependencies [d84c354]
- Updated dependencies [f1cab9d]
- Updated dependencies [8a603c0]
- Updated dependencies [8a603c0]
- Updated dependencies [05a5cae]
- Updated dependencies [9517fc9]
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
- Updated dependencies [68ef504]
- Updated dependencies [9234799]
- Updated dependencies [32ab2c4]
- Updated dependencies [68c571d]
- Updated dependencies [f745816]
- Updated dependencies [b7426bc]
- Updated dependencies [d676bf4]
- Updated dependencies [65e2515]
- Updated dependencies [68cedb7]
- Updated dependencies [e8828f6]
- Updated dependencies [f62ca9b]
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
- Updated dependencies [35239a9]
- Updated dependencies [819e88c]
- Updated dependencies [0798366]
  - @statewalker/vcs-working-tree@0.6.0
  - @statewalker/vcs-utils@0.6.0
  - @statewalker/vcs-core@0.6.0

## 0.5.0

### Minor Changes

- 01d2219: **Every ref and reflog write goes through git's locks; the unlocked writers are gone (breaking).** `vcs-store-files` no longer exports `writeRef`, `writeObjectRef`, `writeSymbolicRef`, `deleteRef`, `updateRef` (`refs/ref-writer.ts`) or `appendReflog`, `deleteReflog` (`refs/reflog-writer.ts`, removed; `hasReflog` moved to `reflog-reader.ts`). They wrote loose refs and reflogs with plain writes. Use `FileRefStore` instead: `set`, `setSymbolic`, `remove`, `batch`, `compareAndSwap` and the new `deleteReflogEntry` all take `<ref>.lock` (and `packed-refs.lock` where git does), and a reflog line is appended while the ref's lock is held, as git does. A batch now also locks every symbolic ref that logs the update (not only HEAD), the updated ref first. As in git, a reflog line that cannot be written now fails the update before its commit (the ref keeps its value) instead of being skipped.
  
  **Stash as git keeps it.** `GitStashStore` (the files `WorkingCopy.stash`) writes `refs/stash` through the history's ref store: a push is a one-ref batch under `refs/stash.lock` that creates the reflog (git's REF_FORCE_CREATE_REFLOG) with the stash commit's message, a drop is `git reflog delete --rewrite --updateref refs/stash@{n}` under `refs/stash.lock` and `logs/refs/stash.lock`, and the last drop deletes the ref and its log. Messages follow git ("WIP on main: abc1234 subject", "On main: message", "index on main: …"), commit timestamps are seconds (they were milliseconds), and `list()` returns the reflog message. Native `git stash list` / `show` / `drop` work on our stashes and we read and drop git's. `GitStashStoreOptions` loses `files` and `gitDir` (and `StashFilesApi` is gone): the store needs only `history`. In `vcs-commands`, `stashCreate` logs every stash (a custom message becomes "On <branch>: <message>", a detached HEAD "(no branch)", as in git), `stashList` lists every `stash@{n}` from the reflog, `stashApply` resolves `stash@{n}`, and `stashDrop` drops any `stash@{n}` (stores without reflogs keep the old `stash@{0}`-only behaviour).
  
  **Pseudo refs and HEAD.** ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD are written and removed through the ref store (under `<name>.lock` on git files) by the merge, cherry-pick and revert state stores and by `GitCheckout`, which also reads them from its `refs`. `createGitFilesBackend({ create: true })` writes HEAD with `setSymbolic` (under `HEAD.lock`).
  
  **New core API.** `BatchOptions.createReflog` creates the updated refs' reflogs whatever their names. `Refs.deleteReflogEntry(name, index, { rewrite, updateRef })` (optional) deletes `name@{index}`; it is implemented by the memory, KV, SQL and git-files stores. `deleteReflogLine` and `ReflogEntryNotFoundError` are exported from `vcs-core`.

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

- 658066d: **Breaking: one fetch client, as git's fetch-pack and remote-curl.**
  
  The transport had three fetch paths (HTTP `fetch`, `httpFetch`, `fetchV2OverDuplex`, plus the v1 client FSM behind `fetchOverDuplex`); each sent every ref as a `have` and `done` in one round, and the v2 one walked only `localHead`. They are now one client (`fetch-client/`) with two I/O adapters:
  
  - **`fetch(options)`** (smart HTTP) asks for protocol v2 (`Git-Protocol: version=2`, `ls-refs` with `ref-prefix`/`symrefs`/`peel`/`unborn`, stateless `fetch` rounds) and falls back to v0 when the server answers the v0 advertisement (`protocolVersion: 0` forces v0). It now writes into a repository: `repository` (`importPack`, streamed) and `refStore` are required, and it returns a `FetchClientResult` (`protocolVersion`, `remoteRefs`, `defaultBranch`, `isEmpty`, `refUpdates`, `followedTags`, `shallow`, `imports`, `packObjects`, `packBytes`, `stats`). `onPack`, `packData`, `localHas`, `localCommits`, `onProgressMessage` and `bytesReceived` are gone (`onProgress` receives the server's messages).
  - **`fetchOverDuplex(options)`** runs the same client over a stateful duplex and speaks v2 or v0 as the server's first line says; it returns `FetchResult` with `report` (the `FetchClientResult`). A fetch with nothing to fetch ends the v0 session with a flush (git's fetch-pack), and a v2 session always ends with one, so the server is done before the caller reuses the channel. `localHead`, `maxHaves` and `filter`-only FSM options are gone; `messagePortFetch` takes the same options.
  - **Negotiation** is git's default negotiator (`Negotiator`): local ref tips walked by commit date, haves in batches of 16 then doubling (stateful v0: +32 past 32; stateless: ×1.1 past 16384), acknowledged commits and their ancestors common and never offered, remote tips already here offered once, `done` when exhausted or `ready` or after 256 haves without a new common commit (`MAX_IN_VAIN`), common commits re-sent in every stateless request. An incremental fetch downloads only the new objects.
  - **Shallow:** the shallow file is kept through new optional `RefStore.getShallow`/`setShallow` (and `Refs.getShallow`/`setShallow` in vcs-core: `MemoryRefs`, `FileRefStore` writes git's `shallow` file under `shallow.lock`, `SQLRefStore` a new `vcs_shallow` table, migration 7). Options `depth`, `deepenRelative`, `deepenSince`, `deepenNot`, `unshallow`.
  - **Tags:** `tags: "auto" | "all" | "none"`. `auto` sends `include-tag` and creates the tags whose objects are here; annotated tags of fetched objects whose tag objects did not come are fetched in a second request (git's backfill).
  - **Refs:** per-ref fast-forward checks; a non-fast-forward is `rejected` unless the refspec has `+` or `force` is set; tags never move unless forced; each ref in its own `refStore.batch` with its old value checked (`atomic`: one batch). Statuses and git's summaries (`[new branch]`, `a..b`, `+ a...b`, `[rejected]`) in `refUpdates`. Negative refspecs exclude refs now.
  - **Removed:** `httpFetch`/`HttpFetchOptions`, `fetchV2OverDuplex`/`FetchV2OverDuplexOptions`, `clone`/`CloneOptions`/`CloneResult` (a clone is a fetch into an empty repository), `RawFetchResult`, `HttpFetchResult`, `BaseFetchOptions`, and the client FSMs `clientFetchTransitions`/`clientFetchHandlers`, `clientV2Transitions`/`clientV2Handlers`.
  - **New exports:** `openHttpConnection`, `openDuplexConnection`, `UploadPackConnection`, `RemoteRef`, `fetchFromConnection`, `FetchClientOptions`, `FetchClientResult`, `fetchPack`, `Negotiator`, `lsRefs`, `mapRefs`, `refPrefixes`, `planRefUpdates`, `applyRefUpdates`, `isFastForward`, `FetchRefUpdate`, `PktStream`, `readSidebandPack`, `nextFlush` and git's flush constants, `ChunkQueue`, `peelFully`.
  - **Server:** the v0 advertisement (HTTP and duplex) lists the peeled line (`<oid> <tag>^{}`) of each annotated tag, as git's, so clients can follow tags. `createRepositoryFacade({ history })` accepts a plain `History` (a `DefaultSerializationApi` over it when it has none).
  
  **vcs-commands:** `FetchCommand` and `CloneCommand` run on the client: haves from the local refs, `setDepth`/`setShallowSince`/`addShallowExclude`/`setUnshallow` reach the server and the shallow file, `setTagOpt` is honoured, `setForceUpdate` and `+` refspecs allow non-fast-forwards (others are `REJECTED`, `LOCK_FAILURE` for a ref-store refusal), `--prune` deletes the refspec destinations whose source is gone. `TrackingRefUpdate` gains `summary` and `reason`. A fetch without refspecs fetches the remote HEAD (objects only), as git. `CloneCommand` writes `refs/remotes/<remote>/*` (bare: `refs/heads/*`, mirror: `refs/*`), all tags unless one branch is cloned (then tags follow), the local default branch and HEAD. The internal `importPackIntoHistory` is gone.
  
  **Review fixes:** wants and known-common tips are decided by completeness (reachable from the local refs, git's mark_complete), not object presence, so a fetch after an interrupted one transfers what is missing instead of writing a ref to a broken history (`Completeness`). Tags follow only when a refspec has a destination (git's autotags). A refspec source the remote lacks fails with `couldn't find remote ref <src>` (`missingRefsOk` for configured refspecs; `FetchCommand` passes it for `remote.<name>.fetch`). `refspecs` may be a `RefspecResolver`. v2 resets the in-vain count on every ACK, as git. `isFastForward` is exact under clock skew. `setShallow(commits, expected)` refuses when the shallow commits changed meanwhile (all three stores). `tagsNotFollowed` reports tags a stateful v0 fetch could not backfill. vcs-commands: `--prune` keeps refs a negative refspec excludes; `CloneCommand.setBranch` of a missing branch fails (`Remote branch X not found in upstream origin`) and of a tag checks out a detached HEAD; a shallow clone is single-branch (the remote HEAD's branch, tags following).
- 07ace72: **Breaking: one pack importer, byte for byte and streamed.**
  
  - **New in vcs-core:** `unpackObjects(objects, pack, options?)` is git's `unpack-objects`. It reads the stream once, writes every object as a loose object exactly as git frames it, resolves OFS and REF deltas (thin packs from the objects the store has), bounds memory (`baseCacheBytes`, `bigObjectThreshold`), refuses corrupt packs with `PackError` and an object stored under the same id with other bytes with the new `ObjectCollisionError`. `importPack(objects, pack, { packs, unpackLimit })` keeps a pack of at least `unpackLimit` objects (default 100, git's `transfer.unpackLimit`) through `packs.install` and unpacks smaller ones, deciding from the pack header only. Also new: `DEFAULT_UNPACK_LIMIT`, `UnpackTarget`, `UnpackObjectsOptions`, `UnpackResult`, `ImportPackOptions`, `ImportPackResult`, and `InstalledPack.types`.
  - **History:** `History.objects` (the object kernel) and `History.packs` (the files backend's `PackSet`), both optional; `createHistoryFromStores`, `createHistoryFromComponents`, `createGitFilesHistory` and `createGitFilesBackend` set them.
  - **Everything delegates:** `SerializationApi.importPack`, `VcsCore.readPack`, the commands' clone and fetch, and the transport's receive paths go through `importPack`, over the history's object kernel. Commits and tags keep headers the parsers do not model; `SerializationApi.importPack` used to drop them and store the object under another id. The server receive path (`createStorageRepositoryFacade` in vcs-transport-adapters, and the HTTP server demo) now passes its kernel as `objects`, so a pushed commit with a `mergetag` header is stored byte for byte. A history with typed stores only (the SQL native stores) is written through them: an object they would re-encode is refused with `ObjectIdMismatchError` before anything is stored. `PackImportResult.blobsWithDelta` is always 0 and `packId` names a kept pack.
  - **Removed:** `SerializationApi.parseLooseObject` (inflate and `objects.putRaw` instead), `SerializationApi.createPackReader`, `PackReaderApi`, `PackEntry`, `PackHeader`, `ParsedObjectMeta`, `SerializationApiConfig.blobDeltaApi`/`treeDeltaApi`/`commitDeltaApi`, `parsePackEntries`, `parsePackEntriesStream`, `parsePackEntriesFromStream`, `indexPackFromStream`; in vcs-utils `PackObjectCache` and `MemoryPackObjectCache`; in vcs-transport `BufferWriter` and `createHttpClientDuplex`.
  - **Streaming fetch (vcs-transport):** `fetch` and `clone` take `onPack(pack)`, which receives the pack demultiplexed from the response body as it arrives (`packData` is then empty). The new `sidebandPackStream(body, { onProgress })` is that demultiplexer (an `ERR` line or channel 3 throws `ServerError`); `httpFetch` and the fetch state machine stream the pack into `importPack` the same way instead of collecting it. A fetch that sent wants and received no pack now fails instead of reporting success, so no refs are written to missing objects; a failed import cancels the response body (`readableStreamToAsyncIterable` cancels a stream it stops reading early). `fetch`'s `timeout` now bounds each wait for the server rather than the whole fetch, so a slow store does not abort a large clone.
  - **vcs-commands:** `importPackIntoHistory` takes a stream; clone and fetch import the pack while it downloads.
- 8c6e99c: **Breaking: receive-pack quarantines a pushed pack until the push is accepted (git's `tmp_objdir`).**
  
  A refused push (unpack error, missing objects, authorize, pre-receive or update refusal of every ref, an atomic push with a refused ref, an internal error, a client gone mid-pack) now leaves no object in the store; an accepted push publishes its objects before the refs move.
  
  - **vcs-core:**
    - `GitObjects.beginQuarantine?()` returns an `ObjectQuarantine` `{ objects, packs?, commit(), discard() }`: writes through `objects` stay invisible to the store until `commit()`, reads see the quarantine then the store, `discard()` removes everything. `createGitObjects` provides it when its `StagingBlobStore` has the new optional `beginQuarantine()` (`StagingQuarantine`).
    - `rawStorageStaging` quarantines under `incoming-<timestampedId>/` keys of the same raw store (memory, KV, SQL) and publishes with `RawStorage.moveAll` (new, optional, all or none) or `move`. `sweepStaleRawStaging` (gc) removes quarantines left by a crash. New export `RAW_QUARANTINE_PREFIX`.
    - `overlayObjects(top, base)`: the quarantine's view.
    - `importPack(objects, pack, { quarantine: true })` imports into a quarantine when `objects` can open one and returns it as `result.quarantine` (a failed import discards it); `SerializationApi.importPack(pack, { quarantine })` and `PackImportResult.quarantine` likewise. Stores without `beginQuarantine` (the SQL native stores) import directly and return no quarantine.
  - **vcs-store-files:** `createGitFilesBackend`'s objects quarantine in `objects/tmp_objdir-incoming-<id>/` (loose objects, kept packs in `pack/`); `commit` moves loose objects, then pack files (`.keep`, `.pack`, `.rev`, `.idx` last) and rescans the packs. `gc` removes stale quarantine directories (`GcResult.removedQuarantines`, new). New exports `beginFilesQuarantine`, `sweepQuarantines`, `QUARANTINE_DIR_PREFIX`.
  - **vcs-store-sql:** `SqlRawStore.moveAll` publishes a quarantine in one transaction.
  - **vcs-transport:**
    - `RepositoryFacade.importPack(stream, { quarantine })` returns `PackImportResult.quarantine: RepositoryQuarantine` `{ repository, commit(), discard() }`; transport's `PackImportResult` is now its own type (the core one without the core quarantine). New `repositoryQuarantine(quarantine, history)`.
    - receive-pack imports with `quarantine: true`, runs connectivity, git's `update()` checks and the hooks against the quarantine's view, commits before applying ref updates and discards otherwise. Hooks get `ctx.repository` (the push's view of the repository). Drivers call the new `releaseReceivePack(ctx)` once the FSM stops (done by `serveOverDuplex` and the HTTP handler).
  - **vcs-transport-adapters:** `VcsRepositoryFacade.importPack` passes the quarantine through.
  - **Freshening:** an object a push sends that the repository already has is written again through the store (`putRaw`), so an old loose object or pack is renewed as git's freshen does (a concurrent gc does not prune what the new ref names); the files quarantine's commit replaces a stale existing loose object or pack file by its quarantined copy.
  - **Abandoned quarantines:** an open quarantine unused for `QUARANTINE_MAX_IDLE_MS` (one hour, new export) or the sweep's expiry, if longer, is swept like a crash leftover.
  - **Bounded runs:** `writeTimeoutMs` (default `DEFAULT_RECEIVE_PACK_WRITE_TIMEOUT_MS`, 10 min) for `serveOverDuplex` receive-pack and the HTTP receive-pack: a client that stops reading ends the run (no ref is updated once a side-band write failed); `hookTimeoutMs` refuses the commands of a hook that does not answer (`HookTimeoutError`). New `withWriteTimeout` / `WriteTimeoutError`.
  - **No silent fallback:** `PackImportResult.quarantined` says whether a `quarantine: true` import was quarantined; receive-pack warns once per facade (`ReceivePackLogger.warn`, new, optional) when it cannot quarantine.
  - `MemoryGcStrategy.getStats` counts objects only (not temporaries or quarantines); the quarantine view of `createRepositoryFacade` keeps its `isBare`; the files quarantine refuses writes once closed.
  - **vcs-testing:** `createObjectQuarantineTests` and `rawQuarantineHelpers`.
- 6a3a31d: **Atomic ref batches in `KVRefStore` and `SQLRefStore`.** They now pass the full `createRefBatchTests` contract, including 20 concurrent two-ref batches.
  
  **`KVRefStore`:**
  - Every ref lives in one root value (`ref:root`, JSON in git's name order).
  - Every write, whole batches included, is one `compareAndSwap` of that value. A lost race re-reads and re-checks; after 100 lost races a batch reports `locked`, and `set` / `setSymbolic` / `remove` throw.
  - The decoded root is cached while its bytes are unchanged.
  - **Breaking:** the persisted layout changed. A store holding the earlier one-key-per-ref layout now throws a clear error instead of reading as empty.
  - **New:** `CorruptRefRootError`, thrown when the root is not a JSON object of strings. A corrupt root is never overwritten.
  
  **`SQLRefStore`:**
  - A batch is planned and written in one `DatabaseClient.transaction`.
  - `list(prefix)` now matches the prefix exactly: case-sensitive, with no `LIKE` wildcards.
  - `set` and batch writes clear a stale peeled id and mark the ref `loose`.
  
  **Both stores, `compareAndSwap`:** it is now a one-command batch, as in `MemoryRefs`, and atomic.
  - It follows symbolic refs: CAS on a symbolic `HEAD` writes its branch.
  - It refuses names other than `HEAD` and those under `refs/` (e.g. `ORIG_HEAD`), and directory/file conflicts.
  - On failure, `errorMessage` names the reason (`mismatch`, …).
  
  **Fixed (vcs-store-sql), `SqlJsAdapter`:**
  - **Concurrent transactions were merged.** A concurrent `transaction` ran inside the one in flight, so a rollback of either undid both. Transactions are now queued.
  - **Plain statements ran inside open transactions.** A `query` or `execute` issued while a transaction was open ran inside it: dirty reads, and writes undone by someone else's rollback. They now wait for the transaction to finish.
  - **Nesting:** a nested transaction joins only through the client handed to `fn`. The `DatabaseClient` docs now state these rules.
  - **Failing `BEGIN`:** a `BEGIN` that fails no longer rolls back a transaction it did not start.
  
  **`kvStoreRefs` (vcs-core)** keeps one key per ref, the layout shared with webrun-storage's `refStore` facade. It stays on the single-command batch, now documented.
- 33612d4: Ref batches write reflogs in every store, as git does with `core.logAllRefUpdates=true`: `MemoryRefs`, `KVRefStore` (`reflog:<name>` keys) and `SQLRefStore` (table `vcs_reflog`, migration 5) now keep them like `FileRefStore`, and expose `getReflog`. New in vcs-core: `planReflog` and `createReflogReaderOf`. The shared ref-batch suite gains reflog cases (`{ reflog: true }`).
  
  `KVRefStore` adds a `:seq` entry (the root's write count) to `ref:root`, so its reflog lines keep commit order. Roots written before it are read as `:seq` 0 and keep working.
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
- 0a580e3: **Breaking: no store holds a whole large object in memory.** A git id hashes `"blob <size>\0"` first, so every write now either knows the size and streams once, or spools to temporary storage.
  
  - **vcs-core:** `GitObjects.putUnsized(type, content)` (new, required for `GitObjects` implementations) keeps content up to `spoolThreshold` (`createGitObjects(store, { spoolThreshold })`, 1 MiB by default) in memory and spools longer content through the optional `StagingBlobStore.spool(content)` (`SpooledContent`) before `put`; `blobs.store` without a size and the tree, commit and tag stores use it. `RawStorage.move?(from, to)` is new and optional; `rawStorageStaging` streams into a `tmp_obj_*` key and renames it when the raw store has `move` (`MemoryRawStorage` does), and spools to such a key. `VcsCore.writeBlob(bytes, { size })` and `SerializationApi.importObject(type, content, size?)` take sizes; `TypedStoreAccess.importObject` now receives the size. Content up to `STAGING_INLINE_THRESHOLD` (256 KiB, `rawStorageStaging(raw, { inlineThreshold })`) skips the temporary: `has` + `store`, nothing written for a duplicate; an id already stored keeps its value. `CompressedRawStorage.size()` streams and counts; with the new `{ gitObjects: true }` option it reads only a git object's header. `RawStorage.sweepStale?`, `StagingBlobStore.sweepStale?`, `GitObjects.sweepStale?` and `GcStrategy.sweepStale?` remove leftovers of interrupted writes; `GcOrchestrator.run({ staleExpiryMs })` (default `DEFAULT_STALE_EXPIRY_MS`, two weeks) calls them and reports `removedTemporaries`. New: `fixedSizeChunks`, `RAW_STAGING_TMP_PREFIX`, `DEFAULT_SPOOL_THRESHOLD`, `sweepStaleRawStaging`.
  - **vcs-store-kv / vcs-store-sql:** `KvRawStore` and `SqlRawStore` cut values over 256 KiB (`{ chunkSize }`) into chunks written as they stream in and read one at a time, and implement `move`. Values written in the old single-entry / single-row format keep reading. SQL migration 6 (`raw_store_chunks`) upgrades existing `raw_objects` / `raw_store` tables; `SqlRawStore` upgrades any table on first use (`upgradeRawStoreTable`). `Migration.upgrade` runs programmatic steps. `SqlNativeBlobStoreImpl.store` streams: with a size it hashes while writing chunks, without one it writes chunks first and reads them back to hash. `importToNative` / `exportToGit` pass blob sizes. `KvRawStore.sweepStale`, `SqlRawStore.sweepStale` and `SqlNativeBlobStoreImpl.sweepStale` remove orphaned chunks and `tmp:*` placeholder rows (chunk tokens record their creation time); `SqlGcStrategy.sweepStale` calls the native one. Raw-store overwrites are last writer wins; a reader concurrent with an overwrite may fail with `Missing chunk`. Rolling back migration 6 deletes rows of chunked values (data loss; `Migration.downgrade`).
  - **vcs-store-files:** `filesStagingStore` spools to `tmp_obj_*` files. The stash stores worktree files with their sizes.
  - **vcs-working-tree:** `storeWorktreeFile` moved here from vcs-commands (still re-exported there); after a `SizeMismatchError` it re-stats the file and retries once with the new size. It now returns `{ id, entry }`, the stat that matched the stored content, which the add commands record in the index.
  - **vcs-testing:** `createRawStorageTests` covers chunked values, failed writes, `move` (`supportsMove`) and streaming writes (`persistedBytes`); `createGitObjectsTests` covers `putUnsized` and, with `persistedBytes`, a 50 MiB blob written and read back with the producer never more than a few MiB ahead of the store.
  - **vcs-utils:** `randomHexId`, `timestampedId` and `timestampOfId` build ids from `crypto.getRandomValues`; no package source uses `crypto.randomUUID` any more (missing on non-secure browser origins).
- 60dd7da: **Breaking: every store reads and writes objects through the object kernel (`GitObjects`).**
  
  Removed: `GitObjectStore`, `GitObjectStoreOptions`, `createGitObjectStore`, `GitObjectHeader`, `loadWithHeader`, `VolatileStore`, `VolatileContent`, `MemoryVolatileStore` (vcs-core); `FileVolatileStore` / `createFileVolatileStore` (vcs-store-files); `createGitObjectStoreTests` and `createVolatileStoreTests` (vcs-testing). Replace `createGitObjectStore(raw)` with `createGitObjects(rawStorageStaging(raw))`, and for a `.git/objects` directory use `createGitObjects(filesStagingStore(files, objectsDir))`.
  
  - `createBlobs`, `createTrees`, `createCommits`, `createTags` and `createHistoryFromComponents({ objects })` take a `GitObjects`; `createMemoryObjectStores`, `createKvObjectStores` and `createSqlObjectStores` return one as `objects`.
  - `Blobs.store(content, size?)`: with a size, the blob is written in one pass without being buffered.
  - `createGitFilesBackend` builds its objects as `withPacks(createGitObjects(skipPacked(filesStagingStore(...), packs)), packs)`: reads try loose objects, then packs, and an object already packed is not written again (as git and JGit). gc and repack ignore anything in `objects/` that is not an object file, such as git's `objects/ab/tmp_obj_*` in flight.
  - The typed stores' `remove` still returns false for a string that is not an object id; `GitObjects.remove` throws `InvalidObjectIdError` for one.
  - Stored bytes: the memory, KV and SQL object stores (and the `BlobStore` behind `createVcsCore` and `createStorageRepositoryFacade`) now hold zlib loose objects, as `.git/objects` does. Data those stores persisted before is not readable; re-import from a git remote.

### Patch Changes

- c60d922: **Breaking (vcs-utils):** incremental SHA-1 goes through one `Hasher` interface (`update` / `digest` / `clone`) from `createSha1()`, on `@noble/hashes`. The vendored `Sha1` class, `newSha1` and `sha1Sync` are removed.
  
  Migration: `new Sha1().update(data).finalize()` becomes `createSha1().update(data).digest()`, and `sha1Sync(data)` becomes `createSha1().update(data).digest()`. Unlike `finalize()`, `digest()` can be read only once: the hasher is spent after it, so `clone()` first to keep the state.
  
  New: `computeObjectIdFromStream(type, size, chunks)` hashes a git object in one pass from a declared size, and rejects with `SizeMismatchError` on a short or long stream. `computeObjectId` hashes objects of 64 KiB and more with Web Crypto, and smaller ones with the portable hasher. vcs-core and vcs-store-sql now hash through `createSha1`.
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
