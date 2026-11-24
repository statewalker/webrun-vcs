---
"@statewalker/vcs-commands": minor
---

Add `git.remoteShow()` (`git remote show [-n]`: URLs, HEAD branch, remote branches tracked/new/stale/skipped, `git pull` and `git push` configuration with create/up to date/fast-forwardable/local out of date states, the remote queried through the command's transports), `git.remotePrune()` (`git remote prune [--dry-run]`), `git.remoteUpdate()` (`git remote update [-p] [<group>|<remote>...]`, `remotes.<group>`, `remotes.default`, `remote.<name>.skipDefaultUpdate`), `git.remoteSetBranches()` (`git remote set-branches [--add]`) and `git.fetchMultiple()` (`git fetch --all`, `--multiple`, `<group>`, `fetch.all`, `-j`/`fetch.parallel` with git's output for parallel runs, the fetches run one after another). Transport commands can hand their transports, credentials and hooks to a command they run (`configureChild`).

These commands reach remotes the configuration names, so their credentials and headers go only where given for (`GuardedTransportCommand`): static ones to `addCredentialOrigin` origins, else the default remote's origin while every remote reached shares it; `setCredentialsForUrl`/`setHeadersForUrl` answer per URL; redirects to another origin carry none. Remote groups nested in groups are fetched as git's children fetch them.
