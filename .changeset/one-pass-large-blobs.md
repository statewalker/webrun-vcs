---
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-transport-adapters": patch
---

**Large blobs in one pass.** `createNodeFilesApi` now streams `write` chunk by chunk (`StreamingNodeFilesApi`; the upstream `NodeFilesApi` 0.10 collects the whole file first), so a blob stored with its size goes from source to `.git/objects` holding about one chunk: `add` passes the worktree size of regular files (and collects a file that changed while being read), and merge, pack import, transport and conflict resolution pass the sizes of the buffers they already hold. `gc()` removes `tmp_obj_*` temporaries older than two weeks (`tmpExpiryMs`, `removedTemporaries`), as `git prune` does. A benchmark (`pnpm --filter @statewalker/vcs-store-files test:bench`) stores 200 MB with live memory under 64 MB and checks it with `git fsck`.
