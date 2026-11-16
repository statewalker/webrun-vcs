---
"@statewalker/vcs-utils-node": patch
---

`createNodeGitHostEnvironment` reads `~/.gitconfig`, the XDG files and the system files through a FilesApi instead of `node:fs`. By default that is a Node FilesApi rooted at `/` (or at the drive of a Windows path). The new `files` option reads them from any FilesApi, such as an in-memory or composite one.
