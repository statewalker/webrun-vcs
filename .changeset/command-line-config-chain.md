---
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**Command-line config (`git -c`) on every config read; discovery's ceiling and file system boundary.**

- **vcs-store-files:** `GitWorkingCopyConfig` reads `GitHostEnvironment.commandLineConfig` last, after `config.worktree`, in scope `command` (git's `do_git_config_sequence`): the working copy's config, submodules' and repositories opened for serving all see it, so `-c` overrides the repository's own settings for every command. Its `include.path` / `includeIf.*.path` are followed (scope `command`, `file:<path>`); a relative include is git's fatal `relative config includes must come from files`, a `gitdir:./` condition never holds. `commandLineConfigError` (and that include error) make `load()` throw `CommandLineConfigError` (exit 128) once the files are read, as git dies at its first config read. `GitConfigOptions.commandLine: false` leaves it out. `listWithOrigin()` gives command-line values without a file; `showOrigin(entry)` prints `--show-origin`'s `file:<file>` / `command line:`. `readProtectedConfig` takes the command line from the chain, so its includes count for `safe.directory` too.
- **vcs-store-files:** `discoverRepository` honours `$GIT_CEILING_DIRECTORIES` (setup.c's `canonicalize_ceiling_entry` and `longest_ancestor_length`: relative entries ignored, `realPath` until an empty entry) and stops at a file system boundary where the FilesApi's `lstat` reports another `dev` unless `$GIT_DISCOVERY_ACROSS_FILESYSTEM` (`FilesystemBoundaryError`, git's two lines, exit 128).
- **vcs-working-tree:** `GitHostEnvironment.ceilingDirectories` / `discoveryAcrossFilesystem`; `withoutCommandLineConfig(environment)` (git's `local_repo_env`); `OpenRepositoryOptions.commandLineConfig` (default true, a server's own `-c`; false for the remote side of a local transport).
- **vcs-utils-node:** `createNodeGitHostEnvironment` fills `ceilingDirectories` and `discoveryAcrossFilesystem` from `$GIT_CEILING_DIRECTORIES` and `$GIT_DISCOVERY_ACROSS_FILESYSTEM`.
- **vcs-commands:** local fetch, push, ls-remote and clone open the remote with `commandLineConfig: false`: its upload-pack / receive-pack never see the client's `-c`, as connect.c clears `local_repo_env`; clone's ownership check of the source's objects (in the cloning process) still does.
