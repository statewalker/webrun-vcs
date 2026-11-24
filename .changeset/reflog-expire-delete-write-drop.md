---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
---

`git reflog expire`, `delete`, `exists`, `write` and `drop` as library commands on `ReflogCommand` (builtin/reflog.c, reflog.c): `callExpire(...refs)` with `setExpire`, `setExpireUnreachable`, `setAll`, `setSingleWorktree`, `setStaleFix`, `setRewrite`, `setUpdateRef`, `setDryRun` and `setVerbose`, plus `gc.reflogExpire*` and `gc.<pattern>.reflogExpire*`; `callDelete(...selectors)` for `<ref>@{<n>}` and `<ref>@{<date>}`; `callExists()` refuses invalid ref names as git; 2.5x's `callWrite(ref, old, new, message)` and `callDrop(...refs)`, refused under `setCompatibility("2.43")` as git 2.43 refuses them. Each returns git's stdout, error lines and exit status (`ReflogUpdateResult`).

vcs-store-files' `expireReflogs` takes named reflogs, `--single-worktree`, `--stale-fix` (reflog.c's `keep_entry`), `--rewrite`, `--updateref`, `--verbose` and a delete's entry selector on both the files and the reftable backends; `dropReflogs` and `writeReflogEntry` are `refs_delete_reflog` and `ref_transaction_update_reflog`, and the reftable store gains `dropReflog` and `appendReflog`. Reflogs are rewritten in git's own format: nothing new is stored, and older versions read the result.
