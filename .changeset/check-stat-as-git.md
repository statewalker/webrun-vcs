---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

**Stat comparison as git's checkStat; smudged entries; unreadable gitdirs; clean pathspecs.**

- **vcs-working-tree:** status, stash and the racy check compare a file with its index entry as git's `ce_match_stat_basic` (new `basicStatMatches`): besides size and the whole-second mtime and ctime, the inode, owner and group where the worktree reports them (an entry recorded without an inode, as 0, then does not match and is re-read, as in git); `core.checkStat=minimal` compares neither (new `WorktreeModeTrust.fullStat`). An entry git smudged (size 0 while its blob is not the empty blob) never matches. The racy smudging on index writes judges seconds as status does, and returns early (no hashing) when the basic stat already differs.
- **vcs-store-files:** a submodule `gitdir:` that is absolute or climbs beyond the FilesApi's root no longer fails status: the submodule's commit is unknown and no change is reported; only a gitdir inside the repository with no `HEAD` is git's fatal error. `isRepository` checks a gitfile's target: one pointing to no repository does not make its directory a nested repository (git clean -d removes it); an absolute target is taken as a repository (never removed on a guess).
- **vcs-commands:** `clean()` with a path filter removes only the directories the filter names (`-- '*.txt'` leaves an emptied `d/sub`), and a glob naming a directory's contents (`u/*`) removes and reports `u/`, as git.

**Repositories with a linked HEAD.** A nested repository or gitfile target whose HEAD is a symbolic link (git writes one under `core.preferSymlinkRefs`) counts as a repository, as git's `validate_headref` accepts it; `objects` and `refs` may be links to directories. `clean -d` keeps such repositories instead of removing them. Owner and group are compared only where the index entry recorded them, so stores that do not keep them never re-hash every file.
