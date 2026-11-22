---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

**A cheaper start for status and `commit -a`; checkout folds case in `verify_clean_subdirectory`.**

- **vcs-working-tree:** an index read no longer hashes the file to check its trailer: git checks it only in `fsck` (read-cache.c `verify_hdr` with `verify_index_checksum`, which fsck alone sets), and never for a null trailer (`index.skipHash`). `parseIndexFile` takes `verifyChecksum` (default true, a null trailer accepted), `IndexFile` and `readIndexFileEntries` take `verifyChecksum` (default false), and `readSharedIndex` hashes a shared index only when asked. An index with a wrong trailer is read as git reads it.
- **vcs-store-files:** `createGitFilesBackend` loads the config sequence once for the pack and ref store settings (it loaded it twice), `readPackSetSettings` takes a loaded `config`, and the loose object store draws its random temporary-name part at its first write, so a store opened to read never loads the runtime's crypto.
- **vcs-commands:** `fsck` checks each index's trailing hash (and a split index's shared index). The index host works out `splitIndex.sharedIndexExpire` only when a write expires shared indexes. On a 15k-file repository the open before status and `commit -a` takes about 10 ms less.
- **vcs-commands:** under `core.ignorecase`, checkout's `verify_clean_subdirectory` (`findInTheWay` with `caseVariantsExpendable`) takes a file the index has in another case as tracked, as git's `read_directory` asks the index through its folded name hashes: a directory a file replaces no longer refuses the checkout because of such a variant, which goes with the directory (git's `checkout_entry` removes the subtree). New files there still refuse it, and a nested repository is still asked exactly (kept, refusing the checkout). `untrackedUnder` takes the folded `IndexPathLookup` and collects the variants; `InTheWay.caseVariants` lists them.
