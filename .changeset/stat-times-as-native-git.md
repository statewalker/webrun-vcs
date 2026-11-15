---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-commands": patch
---

**Index stat data as native git keeps and compares it.**

- **Exact stat on every index write.** `add`, checkout, `stash apply` and clone record a file's full stat (ctime, exact nanoseconds, device, inode, owner) through the new `entryStatOf`; `UpdateStagingEntry` accepts it. Before, `add` kept only the size and a millisecond time.
- **`core.trustctime` and `core.checkStat=minimal`.** Status and the racy check no longer compare ctime when either says so (`WorktreeModeTrust.ctime`).
- **Native git tests** pin git's behaviour (checked on 2.43 and 2.56): exact nanoseconds recorded, a nanosecond-only change ignored, a whole-second change re-checked, a same-size edit caught when the index was written in the file's second and missed when written a second later, and ctime compared only under `core.trustctime`.
