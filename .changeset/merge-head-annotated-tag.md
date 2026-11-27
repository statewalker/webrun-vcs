---
"@statewalker/vcs-commands": patch
---

`git merge` of an annotated tag writes the tag object's id to MERGE_HEAD, as git's `write_merge_heads` does, when the merge stops (`--no-commit`, conflicts, refused hooks); `commit` and `merge --continue` peel MERGE_HEAD's lines to commits, as `read_merge_heads` does (statewalker/webrun-vcs#272).
