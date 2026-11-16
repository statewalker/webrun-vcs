---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport-lfs": minor
"@statewalker/vcs-utils-node": minor
---

**Attributes and end-of-line conversion as git does them, and git's configuration chain.**

- **vcs-working-tree:** `.gitattributes` are read as git's `attr.c` reads them (per-directory files, `$GIT_DIR/info/attributes`, `core.attributesFile` or `$XDG_CONFIG_HOME/git/attributes`, the system file; macros, the built-in `binary`, set / unset / `!attr` / values, no negative patterns), through `AttributesResolver`. `GitContentFilter` is git's `convert.c`: `text`, `text=auto`, `eol`, `crlf`, `-text`, `core.autocrlf`, `core.eol`, `core.safecrlf` (git's warnings and errors), the binary heuristics, the CRLF-in-index rule, renormalisation, `ident`, `working-tree-encoding` (UTF-16 / UTF-32 with git's BOM rules; other encodings fail as git's failed conversion does) and filter drivers registered by the host (`FilterDriver`; a missing required driver fails with git's message). A `Worktree` now has an optional content filter (`contentFilter`, `setContentFilter`): `computeHash` hashes a file as it is cleaned and `writeContent` smudges it (`raw: true` writes as is); `readContent` still gives the file as it is. `MemoryWorkingCopy` installs git's filter on its worktree (options `contentFilter`, `filterDrivers`, `environment`); `storeWorktreeFile` cleans (with `onWarning`, `renormalize`); `readCleanContent` reads a file as the repository would store it. `GitHostEnvironment` describes the user's global files for hosts that opt in.
- **vcs-store-files:** `GitWorkingCopyConfig` reads git's chain: the system and global files (`$XDG_CONFIG_HOME/git/config`, `~/.gitconfig`) from an optional host `environment`, `include.path` and `includeIf` (`gitdir:`, `gitdir/i:`, `onbranch:`), and `config.worktree` with `extensions.worktreeConfig`; writes stay in the repository's file (`getLocal` reads only it). `FileWorktree` supports the content filter, `readGitDirFile` and a global excludes file read through the chain. `GitWorkingCopy` and the factory install git's filter.
- **vcs-commands:** `add`, `commit -a`, `status`, `stash`, `checkout`, `reset --hard`, `clone` and `stash apply` clean and smudge content as git does. `AddCommand.setRenormalize` is `git add --renormalize`, `AddResult.warnings` holds git's line-ending warnings, and a tracked file whose stat still matches is no longer read again (as git's `add_to_index`).
- **vcs-transport-lfs:** `createLfsFilterDriver` is git-lfs's clean / smudge as a filter driver (`filterDrivers: { lfs }`).
- **vcs-utils-node:** `createNodeGitHostEnvironment` gives the user's environment (`HOME`, `XDG_CONFIG_HOME`) for hosts on Node.
