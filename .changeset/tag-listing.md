---
"@statewalker/vcs-commands": minor
---

`git.tagList()` gets git's list mode on the ref filter: `callText()` prints `git tag --list`'s
output byte for byte, with `setPatterns`, `setIgnoreCase` (`-i`), `setLines` (`-n<num>`: each
tag's annotation, a signed tag's message without its signature, a lightweight tag's commit
message), `setSort` after `tag.sort` and `setNoSort` (`version:refname` with
`versionsort.suffix`), `setFormat`, `setOmitEmpty`, `setColor`, and the reachability filters
`setContains`/`setNoContains`/`setMerged`/`setNoMerged`/`setPointsAt`. `call()` applies the same
filters. `ListTagCommand` now extends `RefListingCommand`. Version sorting reports a
`versionsort.suffix`/`versionsort.prereleaseSuffix` without a value as git does
(`error: missing value for ...`, the key then ignored) (statewalker/statewalker-root#296).
