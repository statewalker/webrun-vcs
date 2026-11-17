---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-working-tree": minor
---

**Small deviations from git fixed: empty config booleans, worktree pointer files, `addWorktree`'s admin directory.**

- **vcs-utils:** `parseGitBool`, git's `git_config_bool`: a key with no `=` is true, an empty value (`key =`) is false, the spellings in any case, and integers as `git_parse_int` reads them (`0x10`, `010`, `1k`); anything else is undefined (git refuses it).
- **Booleans everywhere read through it.** `core.ignorecase`, `core.filemode`, `core.symlinks`, `core.autocrlf`, `core.safecrlf`, `core.quotePath`, `filter.<driver>.required`, `merge.*`, `diff.*`, `blame.*`, `status.renames`, `status.showUntrackedFiles`, `extensions.worktreeConfig`, `core.bare` and the other boolean settings: an empty value used to read as true in several of them and now reads as false, as in git.
- **vcs-store-files:** a `.git` file's `gitdir:` and `$GIT_DIR/commondir` are stripped of their trailing `\n`/`\r` only (`read_gitfile_gently`, `get_common_dir_noenv`), never trimmed; a `C:/…` commondir is absolute. New `parseGitfile`, `parseCommonDir`, `parseWorktreeGitdir`, `isAbsoluteGitPath`. `addWorktree` writes `worktrees/NAME/commondir` (`../..`), absolute host paths in the `.git` file and the `gitdir` back-pointer when the FilesApi's root is known, numbers the name when it is taken (`wt1`), and takes `lock` (`git worktree add --lock [--reason]`), so native git can use the worktree. `objects/info/alternates`, `FETCH_HEAD` and the merge/rebase state files are read and written as bytes (non-UTF-8 survives).
- **vcs-working-tree:** `AddWorktreeOptions.lock`. With `core.ignoreCase` a directory's `.gitignore` applies to its path in any ASCII case (git's `fspathncmp`).
- **vcs-commands:** `init` keeps non-UTF-8 bytes in the config when it sets `core.bare`/`core.ignorecase`.
- **vcs-store-sql:** `findByNamePattern` returns entries in git's tree order (a subtree compares as `name/`).
- **vcs-transport:** HTTP Basic auth sends the credentials' UTF-8 bytes (a lone surrogate as its byte); `btoa` threw on characters above U+00FF.
