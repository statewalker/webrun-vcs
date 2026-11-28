---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
---

`git fetch --atomic` with a refused update (a non-fast-forward without `+`, a tag it would clobber) now aborts its transaction as git does: the reference-transaction hook hears `aborted` with the updates queued so far (the pruned refs, then the accepted updates; none in a dry run), in git 2.43 and 2.5x alike. `BatchOptions.abortTransaction` asks a ref store for such an aborted transaction (files, reftable and linked-worktree stores), and a linked worktree's store now tells an empty transaction to its hook too (statewalker/webrun-vcs#500). Every store answers such a batch without writing (`abortedBatch` for stores with no hook of their own: memory, KV, SQL).
