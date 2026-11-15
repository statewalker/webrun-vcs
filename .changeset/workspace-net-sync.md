---
"@statewalker/vcs-workspace": minor
---

**Network sync of a workspace with a remote repository: `@statewalker/vcs-workspace/net`.**

A new entry point keeps a folder (any `FilesApi`) as commits on one branch and syncs it with a served repository over git's own wire protocol. The root entry is unchanged and still engine-free.

- `openGitWorkspace({ folder, history, branch?, identity?, now?, ignore? })` opens a folder over any vcs-core history; `commitWorkspaceChanges(ws, message?)` commits what changed.
- `syncWorkspace(ws, remote, { message?, maxAttempts?, signal?, onEvent? })` commits the folder, fetches the remote branch into `refs/remotes/<name>/<branch>`, integrates it (fast-forward, or a merge commit using `merge3Way` for text both sides changed) and pushes, never forced. Conflicts are kept in the files (git's markers in text, `<path>.theirs-<id>` beside binary files, the changed side against a deletion) and reported in `result.conflicts`, never resolved silently. A push refused because the remote moved meanwhile runs the round again, up to `maxAttempts` (default 5). The folder is checked out before the branch moves, so a failure leaves the branch at what the folder holds; an edit made during a sync is never overwritten (the round starts again). Failures reject with a `SyncError`.
- Remotes: `httpRemote({ url, auth?, fetchImpl? })` (the transport's fetch and push clients over smart HTTP; an httpeers peer connection plugs in as `fetchImpl: meshRemoteFetch(...)`) and `duplexRemote({ connect })` (`fetchOverDuplex` / `pushOverDuplex`, one connection per operation).
- `createSyncServer({ repository, refStore, hooks? })` serves the repository over smart HTTP (`fetch`) and duplex streams (`serve`), and calls `subscribe` listeners from receive-pack's detached post-receive hook with the refs each push moved, so other workspaces can pull. `server.hooks` plugs the same notification into `meshGitHandler`.
- New dependency: `@statewalker/vcs-utils` (the content merge).
