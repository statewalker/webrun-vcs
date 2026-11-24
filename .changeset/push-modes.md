---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
---

`git.push()` follows `git push`'s ref modes and push options, checked against native git 2.43
and 2.56 (statewalker/statewalker-root#306). New setters: `setMirror` (`--mirror`, also
`remote.<name>.mirror`: every local ref pushed and forced, every other remote ref deleted),
`setDelete` (`--delete`, with `tag <name>`), `setCompatibility`. `push.default` follows
`setup_default_push_refspecs` with git's messages (no upstream, multiple upstreams, an upstream
of another name, a triangular workflow, a detached HEAD, `nothing`), `push.autoSetupRemote`, and
2.43's triangular check; a branch named alone goes where `remote.<name>.push` or (under
`upstream`) its upstream maps it. `--all`, `--tags`, `--delete` and `--mirror` refuse each other
and refspecs as each version does, the `tag` shorthand is read, push options come from
`push.pushOption` (an empty value clears them, a value-less one is fatal) when none are given,
and a refspec git refuses throws git's `error:` lines (exit 1). Pushing to a URL that is the push
URL of one configured remote updates that remote's tracking refs (2.5x). In vcs-transport,
receive-pack honours `receive.advertisePushOptions` (`advertisePushOptions`, off by default for
a served repository's config, as git), `PushClientOptions.mirror` mirrors, send-pack checks
`--atomic` and push options where git does (after the pre-push hook), and a push of nothing to
a remote without refs reports git's "No refs in common" (`PushClientResult.noRefsInCommon`).
