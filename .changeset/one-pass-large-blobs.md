---
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-transport-adapters": patch
---

**Large blobs in one pass.** `createNodeFilesApi` now streams `write` chunk by chunk (`StreamingNodeFilesApi`; the upstream `NodeFilesApi` 0.10 collects the whole file first). It writes to a dot-named temporary beside the file and renames it into place, so a failing source leaves the old file intact, and it refuses paths outside the root as `NodeFilesApi` does. The loose-ref reader skips dot-names, as git does. With that, so a blob stored with its size goes from source to `.git/objects` holding about one chunk: both add commands (`git.add()` and the core `AddCommand`) pass the worktree size of regular files (and collect a file that changed while being read; symlinks are collected), and merge, pack import, transport and conflict resolution pass the sizes of the buffers they already hold. `gc()` removes `tmp_obj_*` temporaries older than two weeks (`tmpExpiryMs`, `removedTemporaries`), as `git prune` does. A benchmark (`pnpm --filter @statewalker/vcs-store-files test:bench`) stores 200 MB with live memory under 64 MB and checks it with `git fsck`.
