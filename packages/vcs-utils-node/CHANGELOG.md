# @statewalker/vcs-utils-node

## 0.5.0

### Minor Changes

- 7d77bf8: **`git.clean()` as `git clean`; the index refresh is compare-and-set; submodule gitfiles.**
  
  - **vcs-commands (data loss fix):** `clean().setCleanDirectories(true)` no longer removes tracked directories, staged new files, nested repositories or ignored files. As `git clean -fd`: untracked files are removed one at a time; an untracked directory (no tracked or staged path in it) is entered only with `-d` or a path filter and removed once empty, deepest first, never recursively; nested repositories are skipped unless the new `setForceNestedRepositories(true)` (`-ff`); ignored files only with `setIgnore(false)` (`-x`); the index decides what is tracked (not HEAD). `cleaned` lists what `git clean -n` prints ("Would remove", a wholly removed directory as `dir/`), the new `skipped` the "Would skip repository" lines.
  - **vcs-working-tree / vcs-store-files (index refresh):** status and stash refresh entries compare-and-set (`applyStatUpdate`): only a stage-0 entry still holding the compared id, mode, size and mtime changes, the rest of it (flags such as assume-unchanged) kept; an add made meanwhile is never undone. An index file is refreshed by the new optional `Staging.refreshStats` (`GitStaging`, `FileStagingStore`): read afresh, written under `index.lock` only while it is the index this instance read or wrote, without writing other in-memory edits, and memory changed only once the write succeeded. `isOutdated()` compares the index's checksum, not its mtime. Index entries keep nanoseconds, uid and gid (`StagingEntry.mtimeNs`/`ctimeNs`/`uid`/`gid`), and refreshed entries record the file's exact stat (`LinkStats`/`WorktreeEntry` gain `mtimeNs`, `ctimeNs`, `dev`, `ino`, `uid`, `gid`; the Node FilesApi reads them with a bigint `lstat`), so native git trusts them.
  - **vcs-store-files:** `readGitlinkHead` resolves `gitdir: ../.git/modules/sub` (as `git submodule add` writes it) against the submodule's directory, refusing a path above the FilesApi's root, and reads only regular files (never a FIFO).
  - **vcs-utils / vcs-utils-node:** new optional `PosixFilesApi.rmdir` (an empty directory only, never recursive), implemented by the Node, simulated-links and mounted FilesApis; `FileWorktree.removeEmptyDirectory` uses it, and no directory pruning falls back to a recursive removal.
- d45dfb0: **Links only through the FilesApi contract; checkout keeps local changes as git; workspace sync records links as 120000 entries.**
  
  - **vcs-utils:** the `PosixFilesApi` contract is spelled out (links, beneath-link refusal, modes, `pathSeparators`, case folding) and gains `refusesBeyondLinks` and `openLinkTarget`. New portable `createSymlinkFilesApi(base, { pathSeparators, ignoreCase, precomposeUnicode, defaultFileMode })`: simulated links and permission bits over any FilesApi, kept in a side table in the reserved hidden file `/.webrun-symlinks.json` (`SYMLINK_TABLE_PATH`), with simulated case and Unicode folding for tests. New `createMountedFilesApi(base, mounts)` and `createSubtreeFilesApi(base, root)`, passing the link operations through. All re-exported by vcs-core.
  - **vcs-utils-node:** `PosixNodeFilesApi.write` replaces files with webrun-files' `replaceFile` semantics (Windows retry on EPERM/EACCES/EBUSY; in-place copy over a mount point or across devices, never through a link) and `writeBatched` (short writes repeated, small chunks batched); `createExclusive` too. `chmod` masks with `0o777` (no setuid/setgid/sticky) and works on a descriptor opened without following links. `read` opens with `O_NOFOLLOW | O_NONBLOCK` and checks the descriptor is a regular file (a FIFO is never read). New `openLinkTarget` (a FilesApi at a link's target, for a `.git` linked elsewhere). Directories verified as not-links are cached per instance (cleared on its own removes and moves), and `list` streams in path order (`listInPathOrder`) instead of buffering the tree. New dependency on `@statewalker/webrun-files`.
  - **vcs-store-files:** a `.git` or `.git/objects` that is a symbolic link is followed as git follows it: `resolveLinkedGitDir(files, gitDir)` resolves it through the FilesApi (`openLinkTarget`, or `readlink` within it) and mounts the target; `createGitFilesBackend` uses it. Ref, packed-refs and reflog readers rethrow `BeyondSymlinkError` instead of reading "no ref" (an empty repository). `FileWorktree` skips its own leading-component checks over a FilesApi with `refusesBeyondLinks`, and a forced write (`replaceInTheWay`) also removes an untracked directory where a file must go.
  - **vcs-commands:**
    - **Breaking (behaviour):** a branch checkout without `setForced` is git's two-way merge: a path HEAD and the target agree on keeps its index entry and worktree file (unstaged edits survive); a path they differ on is switched only when index and worktree hold HEAD's version; otherwise the checkout is refused (`status` CONFLICTS, new `CheckoutResult.message` with git's text: "Your local changes to the following files would be overwritten by checkout", "The following untracked working tree files would be overwritten by checkout", "you need to resolve your current index first"). A plain checkout between identical trees no longer rewrites the worktree; `setForced(true)` does, as `git checkout -f`.
    - With `core.ignorecase`, files differing only in case are both checked out (the last wins) and reported in the new `CloneResult.collidedPaths`, as git's "the following paths have collided" warning; only a path beneath a file, link or submodule of another case is refused.
    - `stash apply` writes with `replaceInTheWay`, as `reset --hard` does.
    - `InitCommand` resolves a linked `.git` as clone does.
  - **vcs-workspace (behaviour change):** a symbolic link in a synced folder is recorded as a mode 120000 entry whose content is its target (never followed), as git records it, instead of being skipped (which made peers delete it); written back as a link where the folder's FilesApi can make one, else as a file holding the target (git's `core.symlinks=false`). An `lstat` error fails the walk instead of dropping the file. Special files stay skipped (`special-file`). `FolderFile.link`, `WalkedFile.link`, `folderHasSymlinks`; the `symbolic-link` skip reason is gone.
- d45dfb0: **Breaking: no operation follows a symbolic link; git's Windows path rules on Windows worktrees; the core CheckoutCommand is gone.**
  
  - **vcs-core:** `isValidWorktreePath(path, mode?, { windows? })` / `assertValidWorktreePath`: with `windows: true` (a worktree on Windows) git's Windows rules apply too, as its `verify_path` built for Windows: `\` refused (CVE-2019-1354, `d\post-checkout` would land inside `d`), and `is_valid_win32_path` (drive prefix, control characters and `<>:"|?*`, components ending in a space or a dot, reserved device names `CON`, `NUL`, `COM1`, `LPT1`, `CONIN$`...). Without it `a\b.txt` is an ordinary file name, as git on Linux and macOS; `.git` behind a backslash (`.git\x`) is still refused everywhere (git's `is_ntfs_dotgit`). New `WorktreePathOptions`. New `isGitWorktreeFile(component, "gitmodules" | "gitattributes" | "gitignore" | "mailmap")` (git's `is_hfs_dot*` / `is_ntfs_dot*`, with the NTFS fallback short names `gi7eba~N`, `gi7d29~N`, `gi250a~N`, `maba30~N`); a symlinked `.gitmodules` is refused under all of them.
  - **vcs-utils:** new `BeyondSymlinkError` / `isBeyondSymlinkError`; `PosixFilesApi.lstat` throws it for a path beneath a link (never "absent"). New optional `PosixFilesApi.pathSeparators` (`"/\\"` on Windows).
  - **vcs-utils-node:** `PosixNodeFilesApi` (from `createNodeFilesApi`) never follows a link in any operation: read, write, createExclusive, mkdir, list (recursive too), stats, exists, remove, move, copy, chmod, symlink, lstat, readlink all refuse a path beneath a link (`BeyondSymlinkError`; `exists` answers false). A link at the path is a link: listed and stat'ed with its own size, read as nothing, never listed into, replaced by a write (new file written beside it and renamed over the link itself; a regular file it replaces passes on its permission bits, so a new file gets a new inode), unlinked by remove, copied and moved as a link. Directories are created without following a linked component. On Windows (`platform` option, default `process.platform`) a `\` in a path is refused and `pathSeparators` is `"/\\"` (`"/"` elsewhere).
  - **vcs-store-files:**
    - `FileWorktree` no longer chmods to fixed bits: an executable gets x where r is set (`mode | ((mode & 0o444) >> 2)`) and a regular file loses x, from the file's own mode, so the umask holds.
    - `readContent` / `computeHash` refuse a path beneath a link; `getEntry` / `exists` report it absent; `remove` of it returns false (git's `has_symlink_or_noent_leading_path`).
    - New `WorktreeWriteOptions.replaceInTheWay` (forced checkout: a file or link where a parent directory must go is unlinked, as git's `create_directories` with force).
    - FIFOs, sockets and devices are skipped by `walk` and are no `getEntry`.
    - New `probeCaseFolding(files, gitDir)` / `FileWorktree.probeCaseFolding()` (git init's `CoNfIg` and NFC/NFD probes; only over a FilesApi with `lstat`).
    - `GitResolutionStore` reads and writes worktree files through a `FileWorktree` (new optional `worktree` constructor argument): a link is staged as a link by `markAllResolved` and replaced, not written through, by `acceptOurs` / `acceptTheirs` / `applyRecordedResolution`.
  - **vcs-working-tree:** `Worktree.probeCaseFolding?()`; `WorktreeWriteOptions.replaceInTheWay`; `WorktreeCapabilities.windowsPaths?` (set by `FileWorktree` from its FilesApi's `pathSeparators`: checkout and the restore plans, via `planTreeRestore`'s new `windows` option, then apply git's Windows path rules).
  - **vcs-commands:**
    - Removed the unexported core `CheckoutCommand` (`core-commands/checkout.command*.ts`), which wrote and deleted through raw FilesApi calls; nothing used it.
    - The porcelain `CheckoutCommand` writes a branch checkout through the restore plan, worktree first: paths verified and collisions refused before writing, tracked files the target drops removed, links written as links (or files holding the target), executables, an empty directory per submodule; then HEAD and the index.
    - `reset --hard` and `stash apply` restore symbolic links (as links, or as files holding the target where the worktree or `core.symlinks` cannot have them) instead of refusing them; deletions go first; `reset --hard` unlinks a file or link where a directory must go.
    - `writeTreeRestorePlan` takes `{ symlinks, replaceInTheWay, gitlinks }`.
    - `CloneCommand` and `InitCommand` write `core.ignorecase = true` / `core.precomposeunicode = true` when the probe finds the filesystem folds case or Unicode composition (git writes each only then on Linux; on macOS it also writes `precomposeunicode = false`, which we do not).
  - **vcs-workspace:** `walkFolder` / `snapshotFolder` never read or descend a symbolic link or a special file (over a FilesApi with `lstat`, e.g. `createNodeFilesApi`): they are listed in the new `FolderWalk.special` and reported as skipped with the new reasons `symbolic-link` / `special-file`.
- d45dfb0: **Stash apply as git (index, content merge, conflicts); ignore rules read fresh as git; no leftover walk cache.**
  
  - **vcs-commands (breaking defaults):** `stash apply` no longer restores the index by default (git's default; `setRestoreIndex(true)` is `--index`). The stash's change is merged into the tree written from the current index, so staged content and newly staged files survive; both-sides changes to a file are merged line by line (`mergeLines`), a real conflict is written with git's markers (`Updated upstream` / `Stashed changes`) and staged at stages 1-3 (status CONFLICTS). Without `--index` the index keeps its entries plus the files the stash adds (git stages them); with it, the stash's index change is merged into the index, refused on a conflict with git's "error: conflicts in index. Try without --index.". An index with unmerged entries is refused. Stashed untracked files are restored first and refused, nothing written, when a file stands on a leading component (git's "fatal: cannot create directory at '…': File exists" / "error: could not restore untracked files from stash"). Outcomes compared with native `git stash apply`.
  - **vcs-commands:** restore plans refuse a reserved name only where the worktree's storage reserves it (new `capabilities.reservedNames`, at the storage's root), not on plain worktrees.
  - **vcs-working-tree:** `IgnoreManager.setIgnoreFile(dir, content | undefined)` and `setExcludeFile(source, content | undefined)` replace a source's rules (`addIgnoreFile` now replaces too); a path inside an ignored directory is ignored and cannot be re-included (git: `build/` then `!build/keep.txt`). `WorktreeCapabilities.reservedNames`.
  - **vcs-store-files:** `FileWorktree` rereads `.gitignore`, `info/exclude` and `core.excludesFile` for every walk and ignore check (a changed or removed file is always seen); a walk keeps its lstat-caching view to itself (an abandoned iterator leaves nothing behind).
  - **vcs-utils:** `createSymlinkFilesApi` creates no table on a base without links and rewrites it only when it changed; a stale entry is dropped before `createExclusive`/`write` so a new empty file never reads as a link; `PosixFilesApi.reservedNames` (the table's name at the wrapper's root; passed on by mounts, not by subtrees).
  - **vcs-utils-node:** new `openRepositoryFiles(rootDir, { gitDir })`: the FilesApi to open a repository with, following a `.git` / `.git/objects` linked elsewhere (as git) while every other link stays unfollowed; a FilesApi opened by `openLinkTarget` follows no links itself; `PosixNodeFilesApi.rootDirectory`.
- d45dfb0: **Stash apply and checkout protect untracked files and local changes as git; no instance-lifetime lstat cache; confined composed FilesApis.**
  
  - **vcs-commands:**
    - `stash apply` touches only the paths the stash changes and refuses before writing anything, with git's merge messages: local changes on such a path ("Your local changes to the following files would be overwritten by merge"), untracked files where it writes ("The following untracked working tree files would be overwritten by merge"), untracked files in a directory a stashed file replaces ("Updating the following directories would lose untracked files in them"). It no longer deletes untracked directories nor overwrites unrelated unstaged edits.
    - Branch checkout: untracked files on a leading component of a written path are refused up front (git's `check_leading_path`); a clean directory switches to a file (git's `verify_clean_subdirectory`; untracked files inside are refused with the directories message); directories a switch empties are removed; a local executable-bit change counts as a local change where `core.filemode` holds; a staged deletion of a file the target deletes too is refused ("would be removed by checkout"); ignored files in the way are overwritten (the worktree's `.gitignore` files are read); a case-only rename switches on a case-folding worktree; the stat shortcut compares ctime too.
    - The restore plan refuses a tree entry named `.webrun-symlinks.json` (any case), the simulated-links table.
  - **vcs-utils-node:** `PosixNodeFilesApi` caches nothing across calls (an outside change is always seen); `withLstatCache()` returns a view for one batch whose directory cache is dropped with it, and forgotten on ENOENT/ENOTDIR/ELOOP or when an entry is seen not to be a directory (a write retries once after a cached directory vanished). `openLinkTarget` is opt-in (`openLinkTargets`, also on `createNodeFilesApi`). `chmod` works on a file it cannot read (lstat, then chmod by path).
  - **vcs-store-files:** `FileWorktree.batch(fn)` runs operations in one lstat-cache batch (a walk is one batch too); `isIgnored` reads the `.gitignore` files of the path's directories (never a symlinked one).
  - **vcs-working-tree:** `Worktree.batch?()`.
  - **vcs-utils:** `PosixFilesApi.withLstatCache?()`. `createSymlinkFilesApi`: one table per base shared by all its wrappers, reloaded before and serialized across mutations; a link counts only while its entry and an empty placeholder agree (mutations ordered so an interruption never makes a file read as a link); move and copy forget what the target held; `..` refused; the reserved table name compared case- and NFC-insensitively; new `isReservedFilesName`. `createSubtreeFilesApi` / `createMountedFilesApi`: `..` refused, `openLinkTarget` forwarded only with `forwardOpenLinkTarget`, a mount point (or a directory holding one) cannot be removed, and listings include what is mounted below.
- d45dfb0: **The worktree never follows a symbolic link; Node clones keep executables and links; add stages modes as git.**
  
  - **vcs-utils:** new `PosixFilesApi` (a `FilesApi` with optional `chmod`, `symlink(target: Uint8Array, path)`, `lstat` and `readlink`) and `LinkStats` (`kind` `file`/`directory`/`symlink`/`other`, `size`, `lastModified`, `ctime?`, `mode?`); re-exported by vcs-core.
  - **vcs-utils-node:** `createNodeFilesApi` returns a `PosixNodeFilesApi` (new, exported): `NodeFilesApi` with `chmod`, `symlink`, `lstat` and `readlink`, contained to the root and never following a link (at the path or in a leading component; `chmod` refuses a link). Its `remove` unlinks a link (a dangling one too) instead of following it, `exists` sees a dangling link, and a non-recursive `list` lists links, dangling ones included, with their own size. Link targets round-trip as bytes.
  - **vcs-core:** `isValidWorktreePath(path, mode?)` / `assertValidWorktreePath(path, mode?)`: with mode 120000, a symlinked `.gitmodules` (any case, NTFS `gitmod~1`, trailing dots/spaces, HFS-ignorable code points) is refused, as git's `verify_path`.
  - **vcs-store-files:** `WorktreeFilesApi` is now `PosixFilesApi` (its `symlink` takes the target as bytes). `FileWorktree` reports `capabilities.executable` only with `chmod` and `lstat`, and `capabilities.symlinks` only with `symlink`, `lstat` and `readlink`. With `lstat` it never follows a symbolic link: `writeContent`, `mkdir`, `remove` and `rename` refuse a path beneath a symlink or a file (git's `has_symlink_leading_path`); `writeContent` unlinks a link at the path instead of writing through it and refuses to write over a directory; `remove` unlinks a link (a dangling one too) and leaves a directory in place unless `recursive`; `walk`, `getEntry`, `readContent` and `computeHash` report a link as mode 120000 with its target as content (never descending into a linked directory), an executable as 100755, and `ctime`; a symlinked `.gitignore` is not followed. `checkoutTree` / `checkoutPaths` now write symlinks as links (or files holding the target), chmod files, create an empty directory for a gitlink instead of failing it, and refuse paths beneath a symlink.
  - **vcs-working-tree:** `WorktreeEntry` gains `ctime?`. New `modeFromWorktree(worktreeMode, indexMode, trust)` and `WorktreeModeTrust`, after git's `ce_mode_from_stat`. The status calculator ignores the executable bit where the worktree cannot show it (`capabilities.executable === false`).
  - **vcs-commands:**
    - `AddCommand` stages the mode git would: a link as 120000 with its target as content (never the file it names), and, where the worktree or `core.filemode` / `core.symlinks` cannot be trusted, the index's 100755 / 120000 kept for a regular file.
    - `CloneCommand` checks out last, after HEAD, `refs/remotes/<name>/HEAD` and the configuration, as git; a failed checkout throws the new `CloneCheckoutError` ("Clone succeeded, but checkout failed: …", with the clone's `result`), the repository usable. Every path of the tree is checked before the first write. The index records the worktree's own stat of each entry (a link's from `lstat`) and its ctime.
    - `planTreeRestore` (clone, `reset --hard`, `stash apply`) refuses paths `verify_path` refuses and colliding entries: the same path twice, or a path beneath a planned file, symlink or submodule, case-folded with `core.ignorecase`.
    - `reset --hard` deletes the tracked paths the target drops before writing, as git's unpack-trees: a tracked file or link `d` makes way for `d/x` (this also fixes a file replaced by a directory failing with EEXIST).
    - `core.*` settings are read from the repository's own configuration only (no global or system configuration).

### Patch Changes

- 7d77bf8: **Clean never enters tracked paths; git's racy smudging on every index write; exact nanoseconds.**
  
  - **vcs-commands (data loss fix):** `clean()` never enters a directory standing where the index has a file, link or submodule (a file replaced by a directory, a deinitialised submodule's directory), as git; a path filter removes the untracked directory it names as `git clean -f -- u` does (`u/`), globs (`*.txt`) match as git's pathspecs, a nested repository named by a path filter is passed over silently, and a directory whose `.git` is no repository (an empty `.git`) is removed with `-d`, as git (new optional `Worktree.isRepository`).
  - **vcs-working-tree / vcs-store-files (racy git):** every index write of `GitStaging` / `FileStagingStore` applies git's `ce_smudge_racily_clean_entry`: an entry as read whose mtime second is not older than the index file's, and whose content changed behind a matching stat, is written with size 0 (new `Staging.setRacyCheck`, installed by every command from the worktree; `smudgeRacilyClean`). The index time is the index file's own mtime after every read and write (0, every entry racy, when unknown; never "now"). Entries a refresh proved clean are recorded as they are, not smudged.
  - **vcs-utils-node:** `lstat` builds millisecond times from the nanosecond parts exactly (a ~1.8e18 nanosecond time no longer drifts below its millisecond), so the index records the file's nanoseconds exactly.
  - **vcs-store-files:** a submodule `gitdir:` file pointing where there is no repository, or beyond the FilesApi's root, makes status fail with git's message ("fatal: gitfile does not point to a valid repository: sub/.git") instead of reporting the submodule clean.
  - **vcs-working-tree:** stash push keeps the index's commit for a submodule (as git stash), even when the submodule checked out another one.
  
  **Exact index times.** The index writer records the exact nanoseconds a file's stat carried, and takes the seconds from them: a time in milliseconds (a double) cannot hold nanoseconds at today's dates and can round across a millisecond or a second. Status takes whole seconds the same way.
- Updated dependencies [7d77bf8]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
  - @statewalker/vcs-utils@0.5.0

## 0.4.0

### Minor Changes

- ee92812: **Breaking: only portable APIs in the packages.** Files go through `FilesApi` alone; no package source imports a `node:*` module, and a lint rule (`noNodejsModules`, error for `packages/*/src`) keeps it so.
  
  `@statewalker/vcs-utils-node` now only provides the Node `FilesApi` (`createNodeFilesApi`, returning `NodeFilesApi` from `@statewalker/webrun-files-node`). Removed: the `node:zlib` compression (`@statewalker/vcs-utils-node/compression`, `createNodeCompression`, `deflateNode`, `inflateNode`, `compressBlockNode`, `decompressBlockNode`; the Web `CompressionStream` default is used everywhere), `StreamingNodeFilesApi`, and `createNodeAtomicFiles` (ref batches use `atomicFilesOver(files, gitDir)`, which excludes writers sharing one `FilesApi`, not other processes such as a running `git`).
  
  `createNodeFilesApi().write` is `NodeFilesApi`'s, which streams from `@statewalker/webrun-files-node` 0.11 (a temporary file, then a rename, as the removed `StreamingNodeFilesApi` did), and lock files use its `createExclusive` (`open "wx"`), so they exclude other processes. `atomicFilesOver` now runs its exclusive creates and empty-directory removals one at a time per FilesApi, and a ref commit blocked by another writer's lock directory waits, then reports `df-conflict` instead of throwing.
- c2c944f: **New (vcs-utils):** `createInflater({ raw? })` is a push inflater that reports exactly where each zlib or raw-deflate stream ends: each push returns `{ out, done, consumed }`. `abort()` gives a stream up without an error. States are pooled, as in JGit's InflaterCache. `createInflaterPool()` creates a private pool. `TruncatedStreamError` and `InflateError` extend `CompressionError`.
  
  **Changed (vcs-utils):** `decompressBlockPartial` now throws `TruncatedStreamError` on truncated input; before, it returned short data with no error. `BufferedByteReader.readCompressedObject` and `readDecompressed` now pull and inflate each chunk once, where before they retried the whole buffer. They report corruption as `InflateError` rather than as missing data, and `readDecompressed` yields large objects in pieces. Breaking out of `readDecompressed` early is safe: the rest of the block is skipped. This fixes a size mismatch on large objects that arrive in small chunks.
  
  **Breaking (vcs-utils-node):** `decompressBlockPartialNode` is removed (its binary search ran log2(n) inflates per object); the portable path is exact and takes one pass.
- 46f2a01: **Move to `@statewalker/webrun-files` 0.12 and webrun-sync 0.3.** webrun-files, -browser, -mem and -node go from ^0.11.0 to ^0.12.0. webrun-storage, -content-store, -content-transfer and -files-sync go from ^0.2.0 to ^0.3.0, which are their releases on webrun-files 0.12. Both are breaking lines. webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. Consumers must move to webrun-files 0.12 too, so a single copy of the core is installed.
  
  - **vcs-store-files:** `GitResolutionStore` without an explicit `worktreePath` now defaults it to `dirname(gitDir)`, not the literal path `<gitDir>/..`. That literal path left the resolution to the store, and with `gitDir` at the root it now throws.
  - **vcs-core:** `decodeTreeEntries` now refuses entry names that git fsck rejects: empty, `.`, `..`, or containing `/`. Such names come only from crafted trees, for example fetched from a remote. Checkout turns entry names into worktree paths, and webrun-files 0.12 resolves `..`, so a tree `sub/` → `..` → `.git/config` would otherwise write into the repository's own `.git`.

### Patch Changes

- e509d97: **Lock files use `FilesApi.createExclusive` when the FilesApi has it.** `atomicFilesOver(files, root).createExclusive` now delegates to the FilesApi's own exclusive create (webrun-files: `open "wx"` on Node, Web Locks in the browser, a transaction in sqlite) when it is present, detected at run time. Every git lock goes through it (`<ref>.lock` and `packed-refs.lock` in ref batches, `index.lock`, `gc.pid` and `gc.pid.takeover`), so the exclusion becomes cross-process: native git, other tabs and other FilesApi instances over the same directory are excluded. A delegated create that fails with ENOENT (another process, such as native git, pruned the empty directory between webrun-files-node's `mkdir` and its `open`) is retried, as git's `raceproof_create_file` does. Without it, locks behave as before: check-then-write, exclusive only among writers sharing one FilesApi instance.
  
  **webrun-files 0.11.** The catalog moves `@statewalker/webrun-files`, `-node`, `-mem` and `-browser` to `^0.11.0`. Every one of them now has `createExclusive`, so on Node locks hold across processes: two processes with their own `createNodeFilesApi` over one repository never both take `<ref>.lock` or `index.lock`, and native `git` sees our locks (and we see its). `createNodeFilesApi().write` streams to a temporary file and renames it over the target, and a `createNodeFilesApi({ rootDir: "/" })` accepts absolute paths. The vcs `FilesApi` interface declares the optional `createExclusive`, as webrun-files does.
- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [e509d97]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [07ace72]
- Updated dependencies [b6a5d9c]
- Updated dependencies [ee92812]
- Updated dependencies [c2c944f]
- Updated dependencies [060fcd0]
- Updated dependencies [0a580e3]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [46f2a01]
  - @statewalker/vcs-utils@0.4.0

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/vcs-utils@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-utils@0.1.1
