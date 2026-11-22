---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
---

**Repository ownership checks as git: `safe.directory`, "detected dubious ownership" and
`safe.bareRepository`.**

```typescript
const environment = createNodeGitHostEnvironment(); // effectiveUid: process.geteuid()
const files = createNodeFilesApi({ rootDir: "/" });
// git's setup discovery: refuses another user's repository unless safe.directory lists it,
// and a bare repository found by walking up while safe.bareRepository=explicit
const found = await discoverRepository({ files, cwd: process.cwd(), environment });
```

`discoverRepository` (vcs-store-files) walks up from a directory as git's
`setup_git_directory_gently` does and applies `ensure_valid_ownership` (gitfile, worktree and
git directory owned by the current user, root's `$SUDO_UID`, `GIT_TEST_ASSUME_DIFFERENT_OWNER`)
and `safe.bareRepository`; an explicit `gitDir` skips both, as `$GIT_DIR` does.
`safe.directory` and `safe.bareRepository` are read only from the protected configuration
(`readProtectedConfig`: system, global, command line), with git 2.5x's matching (`*`, real
paths, `<path>/*`, `.`, `%(prefix)/`, `~/`, an empty value resetting, the "not absolute"
warning) or 2.43's (`compatibility: "2.43"`: literal paths). Refusals carry git's text
(`DubiousOwnershipError`, `UnsafeBareRepositoryError`, `ProtectedConfigError`, exit 128).

`Worktree.openRepository` checks the opened repository as git's `enter_repo` (receive-pack,
http-backend, git-daemon) unless `checkOwnership: false`; `OpenedRepository.checkOwnership()`
checks later. A local push refuses another user's repository (receive-pack's lines plus
"Could not read from remote repository"), a local clone refuses to copy one, while local
fetch, ls-remote and `clone --no-local` read any owner's (git 2.48+'s upload-pack).

`GitHostEnvironment` gains `effectiveUid`, `sudoUid`, `assumeDifferentOwner`,
`commandLineConfig` and `prefix`; `createNodeGitHostEnvironment` fills them from the process
(`effectiveUid: null` turns the checks off) and parses `$GIT_CONFIG_COUNT` /
`$GIT_CONFIG_PARAMETERS` (`commandLineConfigOf`). Owners come from the FilesApi's `lstat`
(`LinkStats.uid`); without an effective uid or owners (browser, memory, KV/SQL, Windows) the
checks pass, as git's do without file owners.
