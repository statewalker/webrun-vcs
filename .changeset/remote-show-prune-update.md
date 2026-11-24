---
"@statewalker/vcs-commands": minor
---

Add `git.remoteShow()` (`git remote show [-n]`: URLs, HEAD branch, remote branches tracked/new/stale/skipped, `git pull` and `git push` configuration with create/up to date/fast-forwardable/local out of date states, the remote queried through the command's transports), `git.remotePrune()` (`git remote prune [--dry-run]`), `git.remoteUpdate()` (`git remote update [-p] [<group>|<remote>...]`, `remotes.<group>`, `remotes.default`, `remote.<name>.skipDefaultUpdate`), `git.remoteSetBranches()` (`git remote set-branches [--add]`) and `git.fetchMultiple()` (`git fetch --all`, `--multiple`, `<group>`, `fetch.all`, `-j`/`fetch.parallel` with git's output for parallel runs, the fetches run one after another). Transport commands can hand their transports, credentials and hooks to a command they run (`configureChild`).
