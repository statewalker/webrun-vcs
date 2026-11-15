---
"@statewalker/vcs-workspace": minor
---

**Network sync of a workspace with a remote repository: `@statewalker/vcs-workspace/net`.**

A new entry point keeps a folder (any `FilesApi`) as commits on one branch and syncs it with a served repository over git's own wire protocol. The root entry is unchanged and still engine-free.

- `openGitWorkspace({ folder, history, branch?, identity?, now?, ignore?, caseInsensitive? })` opens a folder over any vcs-core history; `commitWorkspaceChanges(ws, message?)` commits what changed.
- `syncWorkspace(ws, remote, { message?, maxAttempts?, signal?, onEvent? })` does four things, never forcing:
  - commits the folder;
  - fetches the remote branch into `refs/remotes/<name>/<branch>`;
  - integrates it: a fast-forward, or a merge commit against the best common ancestor, with git's recursive strategy for several bases;
  - pushes.
- Text both sides changed is merged byte for byte with `mergeLines`, so CRLF, a missing final newline and non-UTF-8 text are kept.
- Conflicts are kept in the files and reported in `result.conflicts`, never resolved silently:
  - text gets git's markers, labelled with branch and commit;
  - a binary file keeps ours, with theirs beside it under a unique `<path>.theirs-<id>`;
  - a change against a deletion keeps the change;
  - a file against a directory moves the file aside.
- Only a lost race is retried: non-fast-forward, fetch first, or a compare-and-swap loss in receive-pack. A declined hook fails at once. Retries stop at `maxAttempts` (default 5).
- Fetched trees are checked against git's `verify_path` rules before anything is written: a `.git` component in any case, `..`, an absolute path, a backslash or a NUL fails the sync.
- What a folder cannot hold stays in history: ignored paths, submodule entries, executable modes and symbolic links.
- On case-insensitive folders, paths differing only in case are moved aside. Case sensitivity is probed when the workspace opens, or set with `caseInsensitive`.
- Each file is checked again just before a checkout replaces it. New content is staged in a temporary file; an existing file is rewritten in place so it keeps its permissions.
- A checkout cut short is recorded (`refs/workspace/pending/<branch>`) and finished by the next commit or sync, from a plan stored on the first attempt, so retries never merge a merged file twice. When a directory becomes a file, ignored files in it are removed.
- Folder snapshots skip unchanged files by size and modification time. Racily clean entries (a time within `racyWindowMs`, default 3 s, of the last read) are hashed again.
- Merge bases are found with git's paint-down-to-common walk.
- `.git` is refused in its NTFS and HFS+ spellings too. The `.vcs-sync-tmp-` prefix is reserved, and stale temporary files are swept.
- Failures reject with a `SyncError`. A folder that keeps changing fails with its own message.
- Remotes:
  - `httpRemote({ url, auth?, fetchImpl? })`: the transport's fetch and push clients over smart HTTP. An httpeers peer connection plugs in as `fetchImpl: meshRemoteFetch(...)`.
  - `duplexRemote({ connect })`: `fetchOverDuplex` / `pushOverDuplex`, one connection per operation.
- `createSyncServer({ repository, refStore, hooks? })` serves the repository over smart HTTP (`fetch`) and over duplex streams (`serve`).
  - Its `subscribe` listeners are called from receive-pack's detached post-receive hook with the refs each push moved, so other workspaces can pull.
  - `server.hooks` plugs the same notification into `meshGitHandler`.
- New dependency: `@statewalker/vcs-utils`. `@statewalker/vcs-working-tree` (already listed) is now used for streamed blob hashing.
