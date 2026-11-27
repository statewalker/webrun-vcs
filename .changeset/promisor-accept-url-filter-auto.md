---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-store-files": patch
---

Promisor remotes follow git 2.56's `promisor.acceptFromServerUrl` (advertised remotes whose URL an allowlist glob matches are accepted and created as `promisor-auto-*` or named remotes with `advertisedAs`) and git 2.54's `clone`/`fetch --filter=auto` (the accepted remotes' advertised filter, recorded as `auto`). Clone writes `remote.<name>.url` before it lists the refs, as git does; lazy fetches answer the server's `promisor-remote` capability and clone reports their lines; a local remote reached through a symbolic link opens the repository the link leads to.
