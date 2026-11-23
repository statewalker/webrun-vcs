---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
---

**Legacy remotes in `.git/remotes/` and `.git/branches/`, as git 2.x reads them.**

- **Remote lookup:** a remote the configuration gives no URL is read from `$GIT_COMMON_DIR/remotes/<name>` (`URL:`, `Pull:`, `Push:` lines), then `$GIT_COMMON_DIR/branches/<name>` (`<url>[#<branch>]`: fetches `refs/heads/<branch>:refs/heads/<name>`, pushes `HEAD:refs/heads/<branch>`, the branch `init.defaultBranch` else `master`, tags always followed), as remote.c's `read_remotes_file` / `read_branches_file`, by fetch, pull, push, ls-remote, `@{upstream}` and `@{push}`. Its refspecs follow those of a configuration section without URL. git 2.5x's deprecation warning is in `FetchResult.messages`, the new `PushResult.warnings` and `RemoteRenameResult.warnings` (2.43 prints none).
- **`remote rename <name> <name>`** migrates such a remote into the configuration and deletes its file (builtin/remote.c `migrate_file`); renaming it to another name fails as git does (`Could not rename config section`, exit 1).
- **pull** from such a remote fetches with its own refspecs and merges the FETCH_HEAD entry marked for merge (pull.c `get_merge_heads`; no candidate fails as `die_no_merge_candidates`, exit 1). When the fetch moves the checked-out branch (a branches file named after it), the index and worktree are fast-forwarded from the old head first, with pull.c's warning in the new `PullResult.warnings` (`MergeCommand.callCheckoutFastForward`, merge.c's `checkout_fast_forward`); local changes in the way fail as git (exit 128).
- With `GitHostEnvironment.breakingChanges` (git 3.0) neither file is read, as before.
- **vcs-transport:** `TagMode` `"auto-always"` follows tags even when no refspec writes a ref (remote.c's `fetch_tags = 1`).
