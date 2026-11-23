---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": patch
---

git's date parsing (`approxidateCareful`, `parseGitDate`, ...) moves to vcs-utils (vcs-commands
re-exports it), and gc's expiry settings (`gc.reflogExpire*`, `gc.pruneExpire`) are read as git's
`parse_expiry_date`: `2 weeks`, `90.days`, `yesterday`, `two.weeks.ago` and absolute dates work.
