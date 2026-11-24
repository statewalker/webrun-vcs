---
"@statewalker/vcs-commands": minor
---

Add `git.shortlog()` (`ShortlogCommand`: `-s`, `-n`, `-e`, `-c`, `--group=author|committer|trailer:<key>|format:<format>`, `-w`, `--format`, revision ranges, and `git log` output read as git reads its stdin) and `git.checkMailmap()` (`CheckMailmapCommand`: contacts, `--stdin`, `--mailmap-file`, `--mailmap-blob`). One mailmap reader (`GitCommand.readMailmap`) serves log, commit, shortlog, check-mailmap and format-patch, whose cover letter now uses the shared shortlog and names authors through the mailmap as git does; `mailmap.blob` that is no blob reports git's error, a relative `mailmap.file` is read from the worktree's top, and `git log` text output works in a bare repository's working copy.
