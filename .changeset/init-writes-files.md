---
"@statewalker/vcs-commands": patch
---

**`Git.init().setFilesApi(files)` writes the repository to those files.** It used to build an in-memory history whatever FilesApi was given, so nothing reached `.git`: a repository initialized on the browser filesystem (or any FilesApi) vanished on reload and native git could not read it. With a FilesApi, init now creates `gitDir` in git's layout (HEAD, config, objects, refs) through `createGitFilesHistoryFromFiles`; as `git init` does on an existing repository, a second init keeps its HEAD, config and objects. Without a FilesApi the repository stays in memory, as before.
