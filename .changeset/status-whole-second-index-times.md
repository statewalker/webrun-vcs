---
"@statewalker/vcs-working-tree": patch
---

**Status compares stat times in whole seconds, as git's default build.** Git built without USE_NSEC (as most distributions ship it) compares an index entry's mtime and ctime with the file's in whole seconds and catches a same-size edit within the same second with its racy check (an entry whose mtime second is not older than the index file's is re-read). Status now does the same: the sub-second part an index records is not reliable (a time set through `utimes` can come back a few nanoseconds off what git recorded), and comparing it made every unchanged file look changed. The index refresh smudges (size 0) entries modified in the second the index is written, also in whole seconds. Refreshed entries still record the file's exact stat (nanoseconds, device, inode, owner).
