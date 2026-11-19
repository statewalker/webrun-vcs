---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
---

**Submodule summaries as git shows them: `diff --submodule`, `status.submoduleSummary` and `git submodule summary`.**

- `DiffCommand.setSubmoduleFormat("short" | "log" | "diff")` (and the `submoduleFormat` text option) shows a submodule's change as git's submodule.c does: `log` prints `Submodule <path> <a>..<b>:` (`...` when neither side is an ancestor of the other, ` (rewind)` when the new side is older, or "(new submodule)", "(submodule deleted)", "(commits not present)") and the commits of a first-parent left/right walk inside the submodule as `  < subject` / `  > subject` lines, after "contains modified content" / "contains untracked content" for a dirty one; `diff` prints the diff of the submodule's own files under `a/<path>/` and `b/<path>/` (its worktree when it holds modified content). Without the option `diff.submodule` decides, else `short`. It applies to `git diff`, `--cached`, `log -p`/`show`, `status -v` and the `commit -v` template; `format-patch` and the stash patches keep `short`, as git does.
- `DiffCommand.setIgnoreSubmodules(mode)` overrides `diff.ignoreSubmodules` and `submodule.<name>.ignore`.
- `SubmoduleSummaryCommand` (`git.submoduleSummary()`) is `git submodule summary`: `setCached`, `setFiles`, `setForStatus`, `setSummaryLimit` (`-n`), `setCommit` and `addPath`, with git's counts, `Warn: <path> doesn't contain commit` lines, and the `(blob)->(submodule)` / `(submodule)->(blob)` type changes.
- The long status (and the commit template) print "Submodule changes to be committed:" and "Submodules changed but not updated:" when `status.submoduleSummary` is true or a limit (`StatusCommand.setSubmoduleSummary` overrides it); a value that is neither a boolean nor a number fails as git fails.
- `Worktree.openGitlink(path, { name })` falls back to the repository git keeps in `<gitdir>/modules/<name>` when the path holds none (a submodule not checked out, or whose directory is gone), and a `.git` that holds no repository is no longer opened.
