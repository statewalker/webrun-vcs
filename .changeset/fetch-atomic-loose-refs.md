---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": patch
---

`git fetch --atomic` now writes its refs as git does. The updated refs are written loose, and packed-refs is rewritten only to drop the refs `--prune` deletes. Before, a batch of several refs went through packed-refs. The files store's `BatchOptions.loose` now also covers a batch that deletes refs, following git's `files_transaction_finish`: every lock is taken and every check made before the first rename, the updates are renamed into place, then the deletions go (#284).
