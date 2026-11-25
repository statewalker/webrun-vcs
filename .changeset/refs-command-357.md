---
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

`git refs`: `refsMigrate()` converts a repository between files and reftable ref storage (`--dry-run`, `--no-reflog`; the new storage written beside the old one, the config renamed over as the commit point, so a run stopped at any step leaves one complete format), `refsVerify()` runs git's ref database checks (loose refs, root refs, packed-refs, reftable table names; `fsck.<msg-id>`, `--strict`, `--verbose`), and `refsExists()`, `refsList()`, `refsOptimize()` front `show-ref --exists`, `for-each-ref` and `pack-refs`. vcs-store-files adds `migrateRefStorage`, `verifyRefStorage` and `editConfigFile`; the reftable stack reader opens tables of any name git opens (statewalker/statewalker-root#357).
