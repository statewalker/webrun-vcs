---
"@statewalker/vcs-commands": minor
---

`git remote add` completes its options as git's builtin/remote.c `add`: `setFetch` (`-f`, through
`FetchCommand`), `setTrack` (`-t`), `setMaster` (`-m`, the remote HEAD symref), `setMirror`
(`--mirror=fetch|push`, bare `--mirror` with git's warning) and `setTags` (`--[no-]tags`), with
git's refusals and messages; a remote exists as `remote_is_configured` says (the repository's own
configuration or a legacy remote file, not tracking refs alone), and 2.5x refuses names inside or
around another remote's. `git remote set-url` gains `setAdd`/`setDelete`, takes `<oldurl>` as a
POSIX regular expression matched against the URLs as git reads them, and refuses as git does.
`RemoteListCommand.setVerbose(...).callText()` gives `git remote [-v]`'s text. A fetch under git
2.43 compatibility no longer creates `refs/remotes/<name>/HEAD` (2.48+'s `followRemoteHEAD`).
