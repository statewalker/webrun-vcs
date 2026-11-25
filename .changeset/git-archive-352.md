---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils": minor
---

`git archive` (statewalker/statewalker-root#352): `git.archive()` (`ArchiveCommand`) writes git's tar (pax global header with the commit id, ustar prefix and pax records for long paths and link targets) and zip archives (extended-timestamp field, data descriptors for streamed blobs, zip64, the commit id as comment), with `--prefix`, `--add-file`/`--add-virtual-file`, pathspecs (`:(attr)` too, relative to `setCurrentDirectory`), `--mtime`, compression levels, `export-ignore`/`export-subst` (`%(describe)` expanded once), `tar.umask`, the builtin gzip of `tgz`/`tar.gz` and `tar.<format>.command` through `setFilterRunner`; `getTarCommitId` is `git get-tar-commit-id`. vcs-working-tree: the content filter's attributes take `direction: "index"` (git's `GIT_ATTR_INDEX`: the given index alone). vcs-utils: `deflateSync` writes raw deflate data and gzip members (`format`).
