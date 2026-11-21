---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-commands": patch
---

**Checkout into an unborn index, as git (P4.67).**

- `isIndexUnborn(staging)` (git's `is_index_unborn`): no entries and no index file read or written yet, as `clone --no-checkout` and `worktree add --no-checkout` leave it. Memory, KV and SQL stores are never unborn.
- checkout and switch run unpack-trees' initial checkout there (`topts.initial_checkout`): every entry of the target is written and staged, `git checkout <current branch>` included, where ours used to read the missing index as HEAD's files staged as deleted and write nothing. Untracked files in the way still refuse the switch with git's message (the index stays unborn); sparse-checkout patterns apply (entries outside are skip-worktree, an untracked file there keeps its entry tracked). `checkout --orphan` checks HEAD's files out into the new branch's index.
- `CheckoutCommand.setOnlyMergeOnSwitchingBranches` (git's `only_merge_on_switching_branches`, set by `SwitchCommand` and to be set for a bare `git checkout -b <new>`): a switch naming no target (a new branch without a start point, `--detach` without a commit) only moves HEAD, leaving index and worktree alone.
- The two-tree `read-tree -m` takes every entry of the second tree as new in an unborn index (`SwitchTreesOptions.initialCheckout`).
- rebase's clean check counts no staged changes in an unborn index (`has_uncommitted_changes`); a refused checkout of the upstream on a fast-forward ends with `error: could not detach HEAD`, as git's merge backend (`checkout_onto`).
