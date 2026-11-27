---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
---

Loose objects and pack-family files (`.pack`, `.idx`, `.rev`, `.bitmap`, `.mtimes`, multi-pack-indexes, commit-graphs) are now written 0444 under the umask in repositories that are not shared, as git writes them: `createGitFilesBackend` wraps its FilesApi with the new `withReadOnlyObjectFiles` (`isReadOnlyObjectPath`). Commit-graphs respect the umask (0400 under umask 077, as git). FilesApis without modes (memory, browser) are unchanged.
