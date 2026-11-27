---
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
---

fetch: commit an empty ref transaction when there is nothing to update, as git does. The reference-transaction hook hears `preparing`, `prepared`, `committed` with no ref lines. git 2.5x does this on every fetch, a dry run included; git 2.43 only with `--atomic`. New `emptyTransaction` option on `fetchFromConnection` and `applyRefUpdates`.
