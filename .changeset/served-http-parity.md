---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-commands": patch
---

**Server-side parity: a smart-HTTP server over served repositories, the quarantine path for hooks, and local remotes from bare repositories.**

- **vcs-transport:** `createServedHttpHandler` / `createServedFetchHandler` serve smart HTTP from the same `ServedRepository` resolver `serveGitConnection` uses: the repository's hooks run for a push (through `servedRepositoryOf`: pre-receive, update, post-receive, post-update, push-to-checkout, and reference-transaction through `around`, which now lasts until the push has ended), settings are layered as `serveGitService` layers them (`resolveServeSettings`), and services are enabled as git's `http-backend` enables them (`http.uploadpack`, `http.receivepack` for authenticated users only by default via `remoteUser`, `http.getanyfile`; refusals are an empty 403, unknown paths 404, the wrong method 405). `createFetchHandler` is unchanged. `ReceivePackHookContext.quarantinePath` names the push's quarantine directory while its objects are quarantined; `RepositoryQuarantine.path` carries it. `ReceivePackServerOptions` takes `relayPostReceive`, `batchNonAtomic`, `interleaveUpdateHook`, `publishBeforeUpdate` and `preReceiveSeesRefused` (pre-receive given every command, refused ones included, as git's `run_receive_hook` with `skip_broken` 0), as `serveOverDuplex` does. `configBoolOf` reads a boolean of a served repository's config. The handlers' context takes `done`, the promise of the whole run.
- **vcs-core:** `ObjectQuarantine.path`: the quarantine's directory, where the backend keeps one in files.
- **vcs-store-files:** the files quarantine reports its `objects/tmp_objdir-incoming-<id>` directory; `openAdmin()` of a bare repository gives `bareRepository` (open other repositories by path from the git directory, `FETCH_HEAD`).
- **vcs-working-tree:** `WorktreeAdmin.bareRepository`.
- **vcs-commands:** receive hooks get `GIT_QUARANTINE_PATH`, `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` (tmp-objdir.c's `tmp_objdir_env`) during pre-receive, in local, duplex-served and HTTP-served pushes, so a hook running native git reads the pushed objects; pre-receive sees commands refused before it (a hidden ref) as git's does. A bare repository's working copy (`Git.fromWorktreeAdmin`) fetches, pushes, lists and clones through local remotes (relative paths read from its git directory), writing `FETCH_HEAD` in its git directory. `remoteHookSession` (a served repository's hooks, for `servedRepositoryOf`) and `quarantineEnv` are exported.
