---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

`git config`'s write side as a library command, `git.config()` (`ConfigCommand`): get, set, `--add`, unset, `--replace-all` / `--unset-all` with value patterns (`--value`, `--fixed-value`, the legacy positional pattern), `--comment`, `rename-section` and `remove-section`, on the repository's file or a scope's (`--local`, `--worktree`, `--global`, `--system`, `--file`), with git's exit statuses and messages. The file edits (`setConfigMultivarInFile`, `renameConfigSectionInFile` in vcs-store-files) port config.c's `repo_config_set_multivar_in_file_gently`, `maybe_remove_section` and `repo_config_copy_or_rename_section_in_file` over the parser's event offsets, under `<file>.lock`, following symbolic links. `GitHostEnvironment.hostFilesOf` (Node: `createNodeGitHostEnvironment`) gives the storage of host paths for global, system and absolute `--file` writes; `GitWorkingCopyConfig` exposes `configFiles`, `filePath` and `worktreeFilePath`, and `configFilesApiOf` the FilesApi under it.
