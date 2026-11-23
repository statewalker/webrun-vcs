---
"@statewalker/vcs-commands": patch
---

`git.push()` without `setRemote` now picks the remote as `git push` does (`pushremote_for_branch`). The order is `branch.<current>.pushRemote`, then `remote.pushDefault`, then `branch.<current>.remote`, then the one configured remote, then `origin`; a detached HEAD skips the branch's settings. Before this fix it always pushed to `origin`.

When the chosen remote is not configured, push now refuses with git's "No configured push destination." It no longer treats the name `origin` as a path.

The branch's own remote for `push.default=simple` follows git's `remote_for_branch`, including the single-remote fallback. `RemoteConfigStore` gains `remoteForBranch` and `pushRemoteForBranch`, which `@{push}` now shares with push.
