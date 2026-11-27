---
"@statewalker/vcs-commands": patch
---

`git commit --amend` that would make the commit empty (its tree its first parent's, without `--allow-empty`) now refuses as git does: `EmptyCommitError` carries git's `empty_amend_advice` as its message and `stderr` ("You asked to amend the most recent commit, but doing so would make it empty..."), exit status 1, nothing written. Every nothing-to-commit refusal also carries the status git prints on stdout (`EmptyCommitError.stdout`, `git commit --dry-run`'s text). `EMPTY_AMEND_ADVICE` is exported. (#259)
