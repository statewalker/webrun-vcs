---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
---

Plumbing helpers (statewalker/statewalker-root#356): `git.checkRefFormat()` (`--normalize`, `--allow-onelevel`, `--refspec-pattern`, `--branch`; `checkRefFormat` without a repository), `git.stripspace()` (`-s`, `-c`, git's comment-character deaths), `git.urlParse()` (git 2.5x's `url-parse`, `-c <component>`), `git.patchId()` (`--stable`, `--unstable`, `--verbatim`, `patchid.*`; `patchIdsOfPatchText`), `git.var()` (`-l` and every variable), `git.checkAttr()` (`--all` in git's order, `--cached`, `--source`, `--stdin`, `-z`, `builtin_objectmode`) and `git.checkIgnore()` (`-v`, `-n`, `-q`, `--no-index`, `--stdin`, `-z`), each returning git's exit status, stdout and stderr. vcs-working-tree: `Worktree.ignoreMatch` / `IgnoreManager.matchingPattern` (the deciding pattern, its source and line), `AttributesResolver.nameOrder`, `OperationOptions.onAttributeWarning`, `GitHostEnvironment.programVariables`, `defaultEditor`, `defaultPager`; a relative `core.excludesFile` is read from the worktree top; gitignore patterns keep one literal character for wildmatch as git 2.44+ does. vcs-core: `isValidRefName({ refspecPattern })`, `collapseRefNameSlashes`. vcs-utils: `urlParse`, `urlComponent`, `normalizeUrl({ bytes })`. vcs-utils-node: the Node host environment reads the editor and pager variables. vcs-store-files: `FileWorktree.ignoreMatch`.
