---
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

**Reftable repositories can be written and created.** Every ref write of a reftable repository is one transaction appending one table to each stack it changes (`ReftableRefStore` over `createReftableStackWriter`: `tables.list.lock`, a table renamed into place, the lock committed over `tables.list`), its reflog entries in the same table, the reference-transaction hook told `preparing`, `prepared`, `committed` or `aborted` as git's reftable backend does (symbolic refs and root refs included). Tables are written as git's `reftable/writer.c` writes them (`writeReftable`: padded ref blocks, multi-level indexes, obj blocks, deflated log blocks), honouring `reftable.blockSize`, `restartInterval`, `indexObjects`, `geometricFactor` and `lockTimeout`; the stack is compacted geometrically after each write, and whole by `pack-refs`/gc (stale tables removed). `InitCommand.setRefFormat("reftable")`, `GIT_DEFAULT_REF_FORMAT` (`GitHostEnvironment.defaultRefFormat`), `init.defaultRefFormat` and, with `breakingChanges`, git 3.0's default create reftable repositories (`createGitFilesBackend({ create: true, refFormat })`); clones into them write the initial transaction there. Reflog expiry, `reflog delete` and stash drop rewrite reflogs as `reftable_be_reflog_expire`; gc, repack, prune and fsck read reflogs and linked worktrees' refs through the ref store (`ReftableRefStore.reflogNames`, `worktreeRefs`), and `worktree add` writes the new worktree's HEAD into its own stack. The write refusal is gone: `ReftableWriteUnsupportedError` and `Refs.writeRefusal` are removed.
