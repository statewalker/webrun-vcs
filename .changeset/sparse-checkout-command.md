---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": minor
---

**`git sparse-checkout`, and index-writing commands that honour the sparse checkout.**

- New `SparseCheckoutCommand` (`git.sparseCheckout()`): `init`, `set`, `add`, `list`, `reapply`, `disable` and `check-rules`, from git's command line (`setArguments`) or typed setters. Cone-mode pattern files are written byte for byte as git's `write_cone_to_file` writes them, non-cone patterns verbatim; `core.sparseCheckout` and `core.sparseCheckoutCone` go to `config.worktree` with `extensions.worktreeConfig` set; directories are checked as git's `sanitize_paths` checks them; messages and exit statuses are git's. The sparse index is not supported (`--sparse-index` is refused).
- Applying the patterns (git's `update_sparsity`): entries going out of the checkout become skip-worktree and their files are removed with the directories left empty, a changed file stays with git's "not up to date" warning, entries coming back are written.
- `checkout`/`switch`, `reset --hard/--merge/--keep`, `merge`, `cherry-pick`, `revert`, `rebase`, `am` and `clone --sparse` (new `CloneCommand.setSparse`) apply the patterns to the result as unpack-trees does; the warnings are on the results (`CheckoutResult.warnings`, `MergeResult.warnings`, `CherryPickResult.warnings`, `RevertResult.warnings`, `ResetCommand.getWarnings()`).
- `diff` reads skip-worktree entries whose files are present as in the checkout (without writing the index); `rm` refuses paths outside the patterns with git's advice (`RmFailedError`) unless `setSparse(true)`.
- `parseSparseCheckoutPatterns` reports git's warnings for patterns cone mode cannot read (`warnings`), and gives the cone's hashsets (`coneSets`) and the lines read; new `sparsePatternsFromLines`, `sparsePatternsFromCone`, `splitPatternLines`.
- `GitWorkingCopyConfig.set`/`add` write the variable name as spelled (`sparseCheckout`), as git does.
