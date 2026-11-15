---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

**Stash apply leaves conflicts as git does; ignore rules read once per operation, for every parent of a walk's prefix.**

- **vcs-commands:** `stash apply` conflicts now match native git. A conflicted path is never deleted. In a modify/delete conflict the surviving side stays in the worktree, staged at 1 and 2 or 3 (UD/DU); when the stash's side survives it is written, behind the untracked-file check. In a file/directory collision the directory keeps the name and the file moves aside to `<path>~Updated upstream` (ours) or `<path>~Stashed changes` (the stash's), as git names it. Binary files (a NUL in the first 8000 bytes of any side) are not merged: ours stays without markers, all three versions staged. Renames on either side are detected, exact matches first and then by similarity of at least 50%, so a change made to the old path merges into the new one. Conflicts that only the stash side touches are staged too. With `--index`, an entry records the file's size and mtime only when the worktree holds the staged blob; otherwise it records 0, so the unstaged edit is seen. Stash apply and checkout each run as one worktree batch.
- **vcs-store-files:** `FileWorktree` reads the ignore rules once per operation (per `batch`) and for each walk and ignore check outside one. That includes the `.gitignore` of every parent directory of a walk's `pathPrefix`, so a rule changed or removed since an earlier walk is seen.
- **vcs-working-tree:** `info/exclude` takes precedence over `core.excludesFile` whichever was read first, as in git.
