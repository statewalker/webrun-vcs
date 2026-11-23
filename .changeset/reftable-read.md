---
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": minor
---

**Repositories in the reftable format can be read.** A repository with `extensions.refStorage = reftable` (git 3.0's default) now opens: `createGitFilesBackend` reads its refs from `.git/reftable/` (`ReftableRefStore`: `tables.list` and every `*.ref` table, bounds-checked, merged newest first), so resolve, listings, symbolic refs, `HEAD`, reflogs and linked worktrees' own refs work through `Refs`, and with them `log`, `status`, branch and tag listings and `rev-parse`. Writes are not implemented yet: every ref write, and every command that may write refs, refuses with `ReftableWriteUnsupportedError` before it changes anything (`Refs.writeRefusal`); gc and repack refuse there too. SHA-256 tables are refused (`ReftableUnsupportedError`), corrupt or crafted ones with `ReftableFormatError`.
