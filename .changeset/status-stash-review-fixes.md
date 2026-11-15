---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**Nested repositories are never deleted; stash push and status closer to git; index refresh.**

- **vcs-commands (data loss fix):** emptied directories are pruned only when their listing is truly empty, one level at a time (git's `rmdir`), never recursively: a directory holding an untracked nested repository (its `.git`), a FIFO or an ignored file stays. This affected `stash push` (`-u`, `-a`, a staged new file or removed tracked files next to a nested repository), `checkout` and `stash apply`. New optional `Worktree.removeEmptyDirectory` (FileWorktree, MemoryWorktree).
- **vcs-commands (stash push as git):** `setRef(null)` (`git stash create`) leaves the index and worktree alone; a tracked path beyond a symbolic link refuses the stash with git's message ("error: 'd/e.txt' is beyond a symbolic link"), changing nothing; an intent-to-add entry refuses it ("error: Entry 'n.txt' not uptodate. Cannot merge."); a tracked file replaced by a directory and a staged new file deleted from disk keep their index blob in the stash; `-u` always writes the untracked commit (the empty tree when there is nothing), and removes empty untracked directories as `git clean -d`; a submodule records the commit checked out in it.
- **vcs-commands (status):** a submodule whose checked-out commit differs from the index is ` M sub` (porcelain v2 `SC..`; read through the new optional `Worktree.readGitlinkHead`); its own dirty content is not inspected. Porcelain v1 quotes paths with spaces as git does; v2 lines of intent-to-add entries as git.
- **vcs-commands / vcs-working-tree (performance):** status and stash write back the stats of entries they proved clean by hashing (git's index refresh, only when the index is unchanged and under `index.lock`), smudging racily clean entries that changed (size 0); stash push compares the index with the worktree once (`scanIndex`) for the check, the worktree tree and the reset, and checks only the blobs it writes (`TreeRestoreOptions.writing`). 3000 files: status after a reset re-hashes once instead of every time; stash push 5.8 s (6005 files hashed) to 1.3 s (none hashed with a fresh index).
- **vcs-working-tree:** new `scanIndex`, `IndexScan`, `statUpdateOf`, `refreshableEntries`, `refreshIndexStats`, `indexTimeOf`; `createWorktreeTree`/`hasTrackedChanges` take an optional scan; `createUntrackedTree` always returns a tree; `WorktreeComparison.smudge`; a directory in place of a file is reported with its entry.
- **demos/examples:** the webrtc-p2p-sync commit check looks at staged changes only; the examples' `addFileToStaging` writes the worktree too, as `git add` leaves it.
