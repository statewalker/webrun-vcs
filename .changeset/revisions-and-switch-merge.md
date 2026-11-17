---
"@statewalker/vcs-commands": minor
---

**git's revision syntax, `switch -m`/`checkout -m`, `checkout -b` refusing an existing branch, several `-m`, `merge --no-commit -m`.**

- One resolver (`RevisionResolver`, used through `resolveRef` by checkout, switch, reset, merge, rebase, branch, diff, cherry-pick, revert and worktree add) reads git's revision syntax as `get_oid` does: `@`, `@{-N}`, `[<branch>]@{upstream}`/`@{u}` (`branch.<b>.remote`/`.merge`, the remote's fetch refspecs, `remote = .`), `[<branch>]@{push}` (`push.default`, `remote.pushDefault`, `branch.<b>.pushRemote`, push refspecs, mirror), `[<ref>]@{<n>}` and `[<ref>]@{<date>}` (git's `read_ref_at`, with its "only goes back to" warning and "only has N entries" refusal), `~`/`^`, `^{commit|tree|blob|tag|object|}`, `^{/<regex>}` and `:/<regex>` (POSIX extended, youngest reachable match first, `!-` and `!!`), `<rev>:<path>`, `:<path>` and `:<n>:<path>`. New `RevParseCommand` (`git.revParse()`, `rev-parse --verify`), `RevisionError` for git's `fatal:` lines (`no upstream configured for branch 'x'`, `HEAD does not point to a branch`), and `approxidateCareful` (git's approxidate) in the date module.
- `switch().setMerge(true)` and `checkout().setMerge(true)`: git 2.55+'s `-m`, local changes the switch would lose are stashed, the switch made and the stash applied with the labels `<target>` / `local` / the branch left; a conflict keeps the stash entry (`autostash while switching to '<target>'`). `stashApply().setLabels({ ours, theirs, base })` is `stash apply --label-ours/--label-theirs/--label-base`.
- `addMessage()` on `commit()`, `merge()` and `tag()`: several `-m` joined by a blank line.
- `merge().setCommit(false)` with a message writes `MERGE_MSG` as git does (the message plus a newline).
- Switch and checkout read a name's branch syntax as git does (`loc@{u}` is the local branch `main` when `loc` tracks it with `remote = .`; `switch @{u}` is refused as `a branch is expected, got remote branch 'origin/main'`).
- **Behaviour change:** `checkout().setCreateBranch(true)` on an existing branch is refused as `git checkout -b` refuses it (`RefAlreadyExistsError`, `fatal: a branch named 'x' already exists`); the new `setForceCreateBranch(true)` is `checkout -B` (create, or reset the branch to the start point), which `setCreateBranch` used to do.
