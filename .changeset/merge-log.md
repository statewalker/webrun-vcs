---
"@statewalker/vcs-commands": minor
---

Merge messages as git's fmt-merge-msg writes them. `git.fmtMergeMsg()` (`FmtMergeMsgCommand`) is
`git fmt-merge-msg` over FETCH_HEAD-style lines or the heads `git merge` would be given:
the title (`merge.suppressDest`, `--into-name`), annotated tags' messages, and the shortlog
(`--log[=<n>]`, `--no-log`, `merge.log` and its old name `merge.summary`, `merge.branchdesc`,
`# By`/`# Via` credits). `MergeCommand` builds its message through it and gains `setLog`,
`setSignoff` (git's `Signed-off-by:` trailer, added before the hooks see MERGE_MSG) and
`setIntoName`; its default title now follows git's `dwim_ref` (a tag before a branch of one
name, `branch 'x' (early part)` for `x~2`) and `merge.suppressDest`, and MERGE_MSG holds the
generated message without a final newline while the hooks run, as git writes it. `git pull`
describes the merged head from FETCH_HEAD, so `merge.log` lists the pulled commits.
