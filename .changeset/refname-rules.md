---
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
---

**Breaking (vcs-core):** `isValidRefName(name, { allowOneLevel? })` now gives exactly the verdict of `git check-ref-format`. One-level names such as `HEAD` or `main` now return `false` unless `allowOneLevel` is set. It also refuses names the old check accepted:
- a component that starts with `.` or ends with `.lock`;
- a name that ends with `.`;
- `@`;
- `a/./b`;
- lone UTF-16 surrogates.

**New (vcs-core):**
- `isValidBranchName` and `isValidTagName`: git's extra rules (no leading `-`, not `HEAD`) applied to the full `refs/heads/…` or `refs/tags/…` name.
- `compareRefNames`: git's order (the byte order of the UTF-8 names).

**Changed (vcs-commands):** branch create, branch rename, tag, and both `checkout -b` paths validate names as git does.
- Newly refused: `a/.hidden`, `x.lock/y`, `trailing.`, `a/./b`, `a//b`, the branch `HEAD` and the tag `HEAD` (git 2.48+).
- Newly accepted: `@`.
- `checkout -b` validates names for the first time.
- Branch and tag lists are in git's order (uppercase first).

**Changed (vcs-store-files):** `packed-refs` is written in git's byte order, as git writes it. git re-sorts a file without the `sorted` trait on read, so this changes only the file's order, not how it reads.
