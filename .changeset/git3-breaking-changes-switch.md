---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-utils-node": patch
---

**git 3.0 switch.** `GitHostEnvironment.breakingChanges` (and `createNodeGitHostEnvironment({ breakingChanges })`) asks for the behaviour of a git built with `WITH_BREAKING_CHANGES`, the changes planned for git 3.0. Off by default (git 2.5x). The behaviours it changes follow in later releases.
