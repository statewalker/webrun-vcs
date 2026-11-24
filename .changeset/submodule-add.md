---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
---

`git submodule add` as a library command (statewalker/statewalker-root#326): `git.submoduleAdd()`
(`SubmoduleAddCommand`: `setURI`, `setPath`, `setName`, `setBranch`, `setForce`, `setQuiet`,
`setReference`, `setDepth`, `setTransports`, `setCompatibility`) follows
builtin/submodule--helper.c's `module_add`: the repository cloned into `.git/modules/<name>` (or
`submodule.<name>.gitdir` under `extensions.submodulePathConfig`) with `GIT_PROTOCOL_FROM_USER=0`,
a gitfile and `core.worktree` linking it to its path, `checkout -f -q [-B <branch>
origin/<branch>]`, then `submodule.<name>.url`/`.active` in `.git/config`, `path`/`url`/`branch`
in `.gitmodules`, the gitlink and `.gitmodules` staged. Relative URLs resolve against the
superproject's remote; an existing repository at the path is added as it is; git's refusals and
messages (a path in the index, an ignored path without `-f`, a bad URL or name, a name another
path uses in 2.5x, a kept git directory without `-f`, a held index lock, `protocol.file.allow`)
are reproduced for 2.43 and 2.56. `Worktree.openGitlink` takes an `environment` to open the
submodule with. `git add`'s ignored-path advice now uses git 2.43's wording under 2.43
compatibility.
