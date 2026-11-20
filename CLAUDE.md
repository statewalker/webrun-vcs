# Claude Code Project Guidelines

## Project Overview

**webrun-vcs** is a pure-TypeScript Git implementation (read/write) organized as a pnpm monorepo.

Key packages: `vcs-core` (objects, refs, packfiles), `vcs-working-tree` (index, checkout, worktree), `vcs-commands` (porcelain API), `vcs-transport` (fetch/push protocols), `vcs-transport-lfs`/`vcs-transport-xet` (large objects), `vcs-store-*` (storage backends), `vcs-workspace` (file sync plus versioning).

Tech stack: TypeScript, Node.js 24, pnpm 10 workspaces (via corepack), Vitest (testing), Biome 2 (lint + format), Rolldown (bundling). Internal dependencies use `workspace:^`; external ones use the pnpm catalog (`catalog:`) in `pnpm-workspace.yaml`.

## General Behavior

Do not over-analyze or over-explore before acting. When the task is clear, start implementation immediately. Ask for clarification only when genuinely ambiguous.

## File Operations

When creating notes or documents, always confirm the target directory/path with the user before writing. Never assume the output location.

## Conventions

### Naming
All files and folders use **kebab-case**: `my-component.ts`, `utils/date-formatter.ts`

**[Full Guide](.claude/code/naming-conventions.md)**

### Portable APIs only
Library and app code (`packages/*/src`, `apps/*/*/src`) uses only APIs that exist in browsers and on servers: files through `FilesApi`, Web Streams, Web Crypto, `fetch`. No `node:*` imports (Biome `noNodejsModules` is an error there); tests may use Node (to drive native git, for example). On Node, get a `FilesApi` from `createNodeFilesApi` (`@statewalker/vcs-utils-node/files`). Every file operation goes through the `FilesApi`, symlinks included (`lstat`/`readlink`/`symlink` in its `PosixFilesApi` contract), so a composite or simulated FilesApi (`createSymlinkFilesApi`, `createMountedFilesApi`) works everywhere. The one exception to the no-`node:*` rule is the Node FilesApi itself in `packages/vcs-utils-node/src/files` (`posix-node-files-api.ts`, `replace-file.ts`). `git-host-environment.ts` may import `node:os` but not `node:fs`: it reads files through a FilesApi. The Biome overrides in `biome.json` list exactly these files, so any other `node:fs` use fails lint.

### Module Structure
Folder-based exports with wildcard re-exports. Import from `index.js`, use `.js` extensions.

```typescript
// ✅ import { foo } from "../delta/index.js";
// ❌ import { foo } from "../delta/specific-file.js";
```

**[Full Guide](.claude/code/module-structure.md)**

### Documentation Style
Write for humans using narrative prose. Show examples before explanations.

**[Full Guide](.claude/documentation/writing-style.md)**

## Code Quality / Post-Edit Checks

After any refactoring or multi-file edit, run `tsc --noEmit` and fix ALL TypeScript errors (unused imports, type mismatches, missing extends) before reporting completion.

## Testing

When editing existing test files, NEVER overwrite/replace the entire file. Always append or surgically insert new tests alongside existing ones.

## Task Execution

When working from checklist/epic documents, complete ALL items listed — do not skip or forget items. Before reporting done, re-read the checklist and verify every item is addressed.

### Plan Mode
For multi-file features or architectural changes, start in plan mode. Iterate on the plan before switching to execution. Return to plan mode if implementation diverges significantly.

### Subagents
Use subagents for parallel independent subtasks (e.g., researching multiple packages simultaneously, running tests while editing). Keep the main context focused on the primary task.

## Documentation / Notes

When the user asks for structural consistency or formatting conformity in documents, apply it uniformly without arguing — even if some sections seem like they don't need it.

## References

### Source Analysis
Reference implementations (JGit, Fossil) for analyzing patterns and algorithms.

**[Full Guide](.claude/sources.md)**

## Workflows

### Notes
Exploration notes: `notes/src/YYYY-MM-DD/CC-[project]-subject.md`

**[Full Guide](.claude/workflows/note-organization.md)**

### Planning
Approved plans, specs and decision records are not kept in this repo. They live in the
notes archive, in the project folder `$NOTES_DIR/docs/repositories-and-workspace/vcs-refactor/`
(`plans/YYYY-MM-DD-<slug>.md`, `adr/YYYY-MM-DD-<slug>.md`); see `$NOTES_DIR/docs/CLAUDE.md`.

### Pull Requests
Branch from `main`, use descriptive branch names (`feat/X`, `fix/Y`). PR titles under 70 chars. Include a test plan in the description.

### Session Protocol
Before ending any session:

```bash
pnpm test && pnpm lint:fix && pnpm format:fix  # Quality gates
git add . && git commit -m "..."               # Commit
git push                                        # MANDATORY
```

**[Full Guide](.claude/workflows/session-protocol.md)**

## Common Pitfalls

- **Import extensions**: Always use `.js` in imports, never `.ts` or extensionless
- **`git-cli-sandbox`**: `apps/demos/git-cli-sandbox/` is stale — ignore its test failures
- **`split()` limit**: `"a b".split(" ", 2)` gives `["a","b"]` not `["a","b c"]` — use `indexOf` + `slice`
- **Refs vs Checkout**: `CommitCommand` uses `history.refs`, not `checkout.head`
- **Apps are built without type checking**: vite builds `apps/*` even when they use removed APIs. After changing a package API, run `pnpm -r typecheck` (it covers the apps) and grep `apps/` for the old names.
- **Workspace cycles**: `vcs-core` depends on `vcs-utils-node`, and `vcs-testing` on `vcs-core`, so `vcs-utils`/`vcs-utils-node` must not depend on `vcs-testing` (not even as a devDependency): pnpm then builds in the wrong order and CI fails on missing declarations. Put such tests in a store package.
- **`toEqual` on large byte arrays**: Vitest `toEqual` on `Uint8Array`s of hundreds of KB or more takes seconds and has caused CI timeouts; compare the bytes directly (length plus a loop, or `Buffer.equals` in tests)
- **Native git in tests**: CI has no `user.name`/`user.email`; pass `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the env of every git call, and fix both `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` when two repositories must produce the same commit ids
- **git versions differ**: CI runs a newer git (2.5x) than the sandbox (2.43); oracle tests that compare bytes with native git must pin config that changed defaults (e.g. `transfer.advertiseObjectInfo`) or normalise version-dependent lines
- **`GIT_CONFIG_GLOBAL=/dev/null` is read-only**: `nativeGitEnv` and most test environments point `GIT_CONFIG_GLOBAL` at `/dev/null`; a `git config --global` (or `git lfs install`, which writes global config) under it locks and renames a regular file over `/dev/null`, breaking every later process on the machine. A test that writes global config sets `GIT_CONFIG_GLOBAL` (or `HOME` with it unset) to a temp file; never run such a command by hand in that environment either. Check `ls -l /dev/null` still shows a character device
- **Background maintenance in native git**: git 2.5x runs `git maintenance run --auto --detach` after `commit` and similar commands; the detached process changes `.git/objects` while a test copies or reads the repository (CI fails with ENOENT). Set `maintenance.auto=false` and `gc.auto=0` (e.g. `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, as `nativeGitEnv` in vcs-commands tests does)
- **Commit identities**: every commit/tag-creating command resolves its author and committer through `resolveAuthorIdent`/`resolveCommitterIdent` (vcs-commands `git-ident.ts`, git's `ident.c` order). Native-twin tests pass the same `GIT_AUTHOR_*`/`GIT_COMMITTER_*` to native git and, through `createNodeGitHostEnvironment({ env })`, to ours, instead of `setAuthor`/`setCommitter`
- **Merge-family twins**: `merge`/`cherry-pick`/`revert`/`rebase`/`pull` native tests build both twins with `buildHistory` (`tests/merge-native-scenarios.ts`) and compare `snapshot(..., normalizeState)` (`tests/merge-native-helpers.ts`); `normalizeState` evens out what 2.43 and 2.5x write differently in `rebase-merge/` (todo `# ` subjects, `message`). A refused `git merge` runs `restore_state` (reset --hard + `stash apply --index`), which leaves AUTO_MERGE and rewrites dirty files through smudge
- **`connection: close` in test HTTP servers**: Node 22's undici 6 asserts (`Parser.finish`, `!this.paused`) when the server closes the socket while the body consumer pauses on the final chunk; test servers keep connections alive and end them in `close()` (`closeAllConnections`)
- **Gitea oracle**: `GITEA=1 pnpm --filter @statewalker/vcs-testing-gitea test` runs a real Gitea (test infra; Node APIs allowed in that package via a biome override)
- **Sorted directory listings**: Node `fs.readdir`, and so FilesApi `list`, returns names sorted, so git behaviour that depends on filesystem order (readdir order of loose objects, reflogs) cannot be reproduced; tests sort such output
- **`git fsck` in 2.5x**: it runs `git refs verify` unless given `--no-references` (`FsckCommand` matches `fsck --no-references`), and dies under `--connectivity-only` on a corrupt packed object
- **Missing files in memory**: `createInMemoryFilesApi().read()` of a missing path yields no bytes instead of failing with ENOENT, so `tryReadFile` returns an empty array there; check `stats(path)?.kind === "file"` first when a missing file must read as absent
- **Commit-graphs and replace refs**: `git commit-graph write` disables replace refs and writes a graph anyway; `git gc` (in-process, replace refs on) writes none, and readers ignore a graph while `refs/replace/` has refs (`commitGraphCompatible`)
- **Bloom statistics differ by version**: git 2.5x asks a root commit's changed-path filter (`rev_same_tree_as_empty`), 2.43 does not, so trace2 `bloom/statistics` of one `git log -- <path>` differ by one check per root reached (`log-path-native.test.ts` allows for it)
- **Benchmarking**: measure the built bundles (`dist/`), not sources through tsx: its `keepNames` wraps every function in `__name` and skews profiles of hot closures
- **FIFO/LRU eviction with `Map`**: `map.keys().next()` skips every slot deleted since the table was rebuilt, so evicting one entry per insert costs microseconds; use `OrderedMap` (vcs-utils) for caches that evict
- **Funcname patterns**: `diff.<driver>.xfuncname`/`funcname` and the builtin driver patterns are POSIX regexes; run them through `compilePosixRegex` (vcs-utils `regex/`), never a JavaScript `RegExp` (different semantics, catastrophic backtracking)
- **Tree modes**: the tree store reads modes canonical (`canonTreeMode`, git's `canon_mode`: a 100664 entry reads as 100644). Code that re-encodes a stored tree or must see the stored modes (fsck, serialization, sync) reads `trees.raw` and decodes it with `decodeTreeBytes(raw)`
- **Cache-tree after an index change**: a cache-tree written with the index must describe the resulting index. Build it from a tree only when the index equals that tree (`primeCacheTree`, as git's `prime_cache_tree`); otherwise invalidate every path where the index differs (`invalidateCacheTreeAgainstIndex`). `writeTree` reuses valid nodes, so a stale one silently drops staged changes from commits. `IndexFile` diffs the entries every cache-tree describes with the ones it writes: the one read or written (`TREE`) and a pending one from `setCacheTree` alike (the staging records the entries at set time), invalidating each path that changed since, so code that edits entries after (or without) setting a cache-tree needs no invalidation of its own; set a tree computed for the final entries after the edits (`rewriteIndex(..., { cacheTree })`), or the diff throws its valid nodes away. Intent-to-add entries are in no tree, skip-worktree or not (`update_one`); tests check a cache-tree with `verifyCacheTree`
- **Faking racy-git in fixtures**: `utimes` sets mtime but never ctime, and git (no `USE_NSEC`) compares ctime seconds under the default `core.trustctime=true`, so a fixture that dates files and the index to fake a racily clean entry still races the real clock through ctime under load (a stat mismatch skips the size-0 smudge in native git and ours alike); set `core.trustctime=false` in such fixtures
- **Ref values are checked**: every ref store refuses a direct value that is not a full lowercase hex object id (`isRefObjectId`, reason `invalid-object-id` in `planRefBatch`); a symbolic ref (HEAD at a branch) is written with `setSymbolic`, never `set("HEAD", "refs/heads/x")`, and test fixtures use real ids, not fakes. Commands that take a revision name resolve it before writing refs (as `rebase().setUpstream("main")` does now)
- **Path checkouts**: `checkout -- <paths>`, `restore` and `reset -- <paths>` share `checkout-paths.ts` / `read_from_tree` (builtin/checkout.c `checkout_paths`, builtin/reset.c) with full pathspecs through `pathspec.ts`; a path checkout that names nothing or hits an unmerged path writes nothing. git 2.43 stops a glob-looking element at an index entry of exactly that name (`x*y.txt`), 2.5x keeps matching: native twins of such elements are 2.5x-only
- **Index flags**: one-way whole-tree index reads (reset, `checkout -f`, autostash) pass `readTree(..., { keepMatching })` so skip-worktree and assume-unchanged entries keep their flags, as git's `oneway_merge`; flagged entries are checked by stat only (`flaggedEntryDiffers`, `entryNotUptodate`), never by content
- **`FilesApi.move` returns false**: it reports failure by returning `false` (the Node FilesApi swallows the errno) instead of throwing; every caller must check the result, or code that then cleans up the source (as `mv` prunes empty source directories) deletes data after a failed move
- **Index lock across a commit**: `commit --only` and `commit -a` hold `staging.lockIndex()` from before they edit the index until HEAD has moved (git's `index_lock`); while it is held write through the lock (`write()`, then `commit()`/`rollback()`), never `staging.write()` (it fails with `IndexLockedError`), and give an `AddCommand` run inside it `setWriteIndex(false)`
- **Adding index entries**: stage paths through `IndexAdder` (vcs-commands `index-adder.ts`, git's `add_to_index`): it drops the stage-0 entries a new one clashes with as a file or directory and invalidates each touched cache-tree path; every `writeTree` refuses such clashes (`verifyTreePaths`) rather than storing a tree with two entries of one name. Code that builds entries itself (reset's `read_from_tree`, `read_tree_some`) drops clashes with `stageZeroClashes` (`has_file_name`/`has_dir_name` compare one stage: conflict stages of a clashing path stay), and every intent-to-add entry it creates stores the empty blob first (`set_object_name_for_intent_to_add_entry`), or native `write-tree`/`status` fail on the index
- **Worktree stat pass**: code that compares many index entries with their files stats them in batches (`withWorktreeEntries` / `getWorktreeEntries`, passing the entry to `compareWithWorktree`), not `getEntry` per path; untracked scans pass `skipFile` (the index's paths) to `walk`. A walk lists through `PosixFilesApi.listKinds` when present, so a FilesApi wrapper that overrides `list` (a test Proxy simulating an unreadable directory) must override `listKinds` too
- **Unreadable directories**: the Node FilesApi's `list` and `listKinds` both throw for a directory they cannot read (EACCES; a missing one lists nothing), and walks report it through `onUnreadable(path, error)`; commands turn that into git's "could not open directory" warning (`unreadableDirectoryWarning`). Tests run as root, which reads any directory: simulate unreadable ones with a FilesApi Proxy (or `vi.mock` of `readdir`), and take the expected lines from native git run as an unprivileged user (`setpriv --reuid=65534`)
- **Sparse checkout in index-writing commands**: a command that writes the index and the worktree together takes `SparseUnpack.start` before it changes anything and follows git's unpack-trees order: its checks and writes skip what `leavesAlone(path)` names (a skip-worktree or new entry staying outside the patterns: never checked for local changes or untracked files, never written or removed), it writes only paths `writes(path)` accepts, unlinks the files `leaving()` decides (verify_uptodate_sparse against the source index, before any write) with its own removals, and once its result is written calls `finish()` (flags, entries coming back into the patterns). Never write a file outside the patterns and remove it afterwards (`switchTrees`, `resetMerge`/`resetKeep`, `restoreWorktreeHard`, checkout and clone do this already). git repeats the patterns' "unrecognized pattern" warnings once per index it builds; ours prints them once per command. Conflicts are passed to `sparse.conflict()`: a conflicted path is written whatever the patterns say only where its source entry was skip-worktree or absent (merge-ort's `record_conflicted_index_entries` checks out a skip-worktree stage-0 entry); one leaving the checkout keeps `CE_WT_REMOVE` and is unlinked, its content left in the stages. `update_sparsity` runs without `o->internal.dir`, so `finish({ preserveIgnored })` treats ignored files as untracked there; elsewhere ask `await worktree.isIgnored(path)`, never a worktree entry's lazy `isIgnored` (it answers before the ignore files are read). A `.gitignore` missing from the worktree is read from its skip-worktree index entry (`setSkipWorktreeIgnoreReader`, git's `read_skip_worktree_file_from_index`)
- **Plumbing trusts the stat data**: `read-tree -m`'s `verify_uptodate` (and `mv`'s refresh) take a file whose stat no longer matches its entry as changed without reading it, so a native-twin test that copies a repository (`cp -a` changes ctime and inode) runs `git update-index -q --refresh` in each copy first; ours compares content there (`entryNotUptodate`) and would pass where unrefreshed git refuses. `setCacheTree(undefined)` drops the `TREE` extension from the next write (read-tree with conflicts writes none)
- **Status untracked modes**: `StatusCommand` defaults to git's `normal` mode (an untracked directory as `dir/`, empty ones hidden); code that needs every untracked file calls `setUntrackedFiles("all")`, and native-twin tests comparing with `git status -uall` must too. `scanUntracked` is dir.c's `read_directory` driven by the dir flags (`wt_status_collect_untracked`). git's normal-mode cache can keep showing `dir/` after the files below it go while the parent's stat stays (the parent's cached name outlives the `check_only` directory): compare a cached status with native git's cached one, not with an uncached run
- **Untracked cache (`UNTR`)**: ours uses and updates it for whole-tree scans without `--ignored` and pathspec, made for the scan's dir flags (0 for `-uall`, 6 for `-unormal`); a cache of other flags is replaced unless it is the configured mode's (`new_untracked_cache_flags`), which is kept untouched. `scanUntracked` (vcs-working-tree) follows dir.c's order, so it lists directories in readdir order (`listKinds(path, { readdirOrder: true })`; plain `readdirSync` sorts) and hashes a `.gitignore` as content plus `\n` unless an up-to-date index entry gives its id. `IndexFile` keeps `UNTR` across entry edits, invalidating the directory of each (path, stage) added or removed. Native-twin tests restore the index bytes and mtime between twins and date changed directories back to a second never used before: two changes in one mtime second are invisible to git's cache too
- **Status text and commit templates**: `StatusCommand.callText` (wt-status.c) and `CommitCommand.callDryRun` / `setEditor` share one formatter (`status-format.ts`); hints follow `determine_whence` (MERGE_HEAD, CHERRY_PICK_HEAD), not the state lines. `git commit` takes `--branch` but no `-b`, and has no `--porcelain=v2` or `--ignored`. git 2.43 writes the scissors line twice in a `--cleanup=scissors -v` template, 2.5x once. An empty config value is false to `parseGitBool`: read a boolean with a default as `value === undefined ? fallback : parseGitBool(value) ?? fallback`, never `parseGitBool(value ?? "")`
- **Nested repositories**: `FileWorktree` walks mark a directory `GITLINK` (and do not enter it) only when its `.git` names a repository (`is_nonbare_repository_dir`, or cannot be checked) and does not resolve to the superproject's own git directory (`treat_directory`'s realpath check); an empty `.git` directory or a gitfile of garbage is walked as any other directory. Code that removes such directories walks with `enterNonRepositoryGitDirs` and removes with `nonRepositoryGitDirs` (as clean and `stash -u` do). Inner `git status` runs mirror git's child flags: `rm` of a submodule `-uall`, `is_submodule_modified` the submodule's own mode (`-uno` when ignoring untracked), `worktree remove` the worktree's own mode
- **Submodule summaries**: `diff --submodule=log|diff`, `status.submoduleSummary` and `SubmoduleSummaryCommand` share `submodule-summary.ts` (submodule.c's header and first-parent left/right walk). Header ids use the superproject's abbreviation, `git submodule summary` the submodule's (`rev-parse --short` run there), else the first 7 digits. Its list is `diff-index --ignore-submodules=dirty`, which overrides `submodule.<name>.ignore` and `diff.ignoreSubmodules` (only `--for-status` skips `ignore=all`), and without `--cached` reports an entry whose submodule HEAD moved even when it is back at the tree's commit. git has no "(not checked out)" line: a submodule not checked out is opened from `.git/modules/<name>`. `format-patch` and plumbing patches ignore `diff.submodule`
- **Hooks**: hooks run only through `GitHostEnvironment.hookRunner` (Node: `createNodeHookRunner` in vcs-utils-node `files/node-hook-runner.ts`, the one file there allowed `node:child_process`); with none set, no hook runs. Commands find and run them through `this.hooks` (`HookSession`, vcs-commands `git-hooks.ts`: `find_hook` over `Worktree.getFiles`, `core.hooksPath`, the `advice.ignoredHook` hint, `GIT_PREFIX`), and a command running another passes `shareHooksOf(this)` so one `getHookOutput()` gathers both. Wired: commit (`commitPrepared`/`runMessageHooks`/`finishCommit`), merge (`mergeCommitHooks`, post-merge in `call`), checkout/switch/restore/clone/worktree add (`runPostCheckoutHook`), rebase (`begin`, `commitOnto`, the end of `processTodo`), the sequencer (`sequencerPrepareMessage`/`sequencerPostCommit`), am (`runAmHook`), push (`runPrePush` via `PushClientOptions.prePush`), the receive side of a local push (`scriptReceiveHooks`/`pushToCheckout` in `local-transport.ts`, with `relayPostReceive`), and `reference-transaction` in the files ref store's `batch` and `remove` of `refs/...` (`FileRefStore.setTransactionHook`, installed by `GitCommand.refsStore` while the command's `call*` runs, the previous hook put back after; the receive side installs the remote's in `withLocalReceivePack`): the root refs git updates in transactions (`isRootRefName`: ORIG_HEAD, CHERRY_PICK_HEAD, ...; AUTO_MERGE marked `only: "2.56"`, 2.43 writes it as a file) run it from `set`/`remove` too, so commands delete them where git does (`OperationState.deleteRef` for git's unconditional deletions: AUTO_MERGE after every commit, reset and branch switch); `setSymbolic` (2.5x runs it for symref writes: a known gap) and linked-worktree refs run none. `committed`/`aborted` run after the locks are released; a deletion adds git's nested packed-store transaction (`<zero> <zero> <ref>`, `aborted` at once when the ref is not packed); a root ref deleted with no hook installed skips packed-refs altogether. Multi-ref batches lock their refs in name order (deadlock-free), the hook still hears the transaction's order. Several refs deleted at once (branch -d, tag -d, remote remove, fetch --prune) go through `removeRefsAsGit` / `Refs.removeAll`: one transaction as 2.5x, or `legacy` (the hooks' compatibility is 2.43) as 2.43's `files_delete_refs`, whose outcome differs too (packed-refs rewritten first, then each ref on its own). A hook given an index (`commit -a`'s lock, `--only`'s `next-index-<n>.lock`) may change it: read it back after pre-commit. Native twins log args, stdin and `GIT_*` with `tests/hooks-native-support.ts`; most hooks send stdout to stderr (pre-push does not), and receive-side hooks run in the git directory with `GIT_DIR=.`
- **`Duplex.end` over Node sockets**: our clients half-close the write side (`Duplex.end`, `endDuplex`) where git closes its end (after a fetch's final `0000`, after a push request); a Node `net` server or client in tests needs `allowHalfOpen: true` on both ends, or the FIN also ends the server's answer ("remote failed to report status")
- **Duplex adapters' half-close**: over a MessagePort the end of a webrun call's input is the half-close, and webrun-rpc's `duplexOverPort` closes a raw port itself when the stream is over (closing it earlier can drop the client's last flush); a WebSocket has none, so `webSocketDuplex` sends an empty binary frame for `Duplex.end` (data frames are never empty) and the `ext::` bridge in `tests/duplex-adapters-support.ts` maps it to the end of git's stdin. Never write an unbounded queue into an adapter: use `createByteQueue` (writes return a promise at the high water mark)
- **CI records tested packages**: CI runs only packages whose inputs changed since they last passed (`scripts/tested.mjs`, records in `.tested/`); after a green run on a pull request the `tested-record` job pushes a "chore: record tested packages" commit to the PR branch, which starts a quick run. Never force-push over it: `git fetch origin <branch> && git merge FETCH_HEAD` before pushing more commits, and merge the PR at the head that commit created. `pnpm test` still runs everything
- **`git add` pathspecs**: `AddCommand` checks patterns as git's `cmd_add`: a pattern that names nothing throws before any change, and ignored paths named without `setForce` reject with `AddFailedError` (carrying `.result`) after the index is written. Code that adds optional paths checks they exist first; `commit -a` runs it with no pattern. git 2.5x refuses `add -u <pattern>` that matches nothing tracked, 2.43 does not

## Self-Maintenance

When you discover an undocumented convention, encounter a repeated mistake, or learn a project-specific gotcha during a session, **propose an update to CLAUDE.md** (or the relevant `.claude/*` file). This keeps guidance current and prevents the same mistakes across sessions.

Trigger examples:
- You get corrected on a pattern — add it to the relevant conventions section
- A build/test fails due to an undocumented requirement — document it
- You discover a stale reference or outdated instruction — fix it

## Project-Specific Tools

For Jira URLs, use the format: `https://<domain>/browse/<ISSUE-KEY>`
