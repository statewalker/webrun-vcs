---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
---

`git fetch`'s flags now match native git 2.43 and 2.56 (native twins in
`fetch-flags-native.test.ts`, from t5510, t5574 and t5553). `FetchCommand.setSetUpstream` is
`--set-upstream`: it writes `branch.<name>.remote`/`merge` through the branch-tracking code
`git branch -u` uses, or gives git's warnings. `--dry-run` now stores the fetched objects as git
does (no ref, no FETCH_HEAD), so it reports forced and refused updates as a real fetch would, and
it prints the auto-followed tags twice as git does. A fetch into the checked-out branch is refused
in a working copy without linked worktrees too. Under 2.5x, a fetch that is not atomic writes its
refs in one batch (`FetchClientOptions.batchNonAtomic`), and the reference-transaction hook hears
git's create-only transaction of `refs/remotes/<name>/HEAD`. Under 2.43, a refused update keeps
the padded summary column, and `--atomic` prints the empty `error: ` line.
